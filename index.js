const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const server = http.createServer(app);
const io = socketIO(server);

// In-memory storage
let paymentStatuses = {};
let clientSockets = {};

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("registerTransaction", (transactionId) => {
    clientSockets[transactionId] = socket;
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Remove the socket from clientSockets
    for (let [transactionId, s] of Object.entries(clientSockets)) {
      if (s.id === socket.id) {
        delete clientSockets[transactionId];
        break;
      }
    }
  });
});

function computeSignature(response, secretKey) {
  const data = `${response}/pg/v1/status${secretKey}`; // Use the correct API endpoint path
  return crypto.createHash("sha256").update(data).digest("hex");
}

app.post("/phonepe/callback", (req, res) => {
  const { response } = req.body;
  const xVerifyHeader = req.headers["x-verify"];

  if (!response || !xVerifyHeader) {
    return res.status(400).send("Invalid request");
  }

  // Split x-verify header to extract signature and salt index
  const [signature, saltIndex] = xVerifyHeader.split("###");

  // Use the appropriate secretKey based on saltIndex
  const secretKey = "6362bd9f-17b6-4eb2-b030-1ebbb78ce518"; // Replace with your actual salt key

  const expectedSignature = computeSignature(response, secretKey);

  if (signature !== expectedSignature) {
    return res.status(401).send("Unauthorized");
  }

  const decodedData = Buffer.from(response, "base64").toString("utf-8");
  let paymentData;
  try {
    paymentData = JSON.parse(decodedData);
  } catch (error) {
    console.error("Error parsing JSON:", error);
    return res.status(400).send("Invalid response data");
  }

  // Extract transactionId and status
  const transactionId = paymentData.merchantTransactionId;
  const status = paymentData.data ? paymentData.data.paymentState : paymentData.status;

  paymentStatuses[transactionId] = status;

  // Notify the client via WebSocket
  const clientSocket = clientSockets[transactionId];
  if (clientSocket) {
    clientSocket.emit("paymentStatus", status);
  }

  res.status(200).send("Payment notification received");
});

app.get("/payment-status/:transactionId", (req, res) => {
  const transactionId = req.params.transactionId;
  const status = paymentStatuses[transactionId] || "PENDING";
  res.json({ status });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
