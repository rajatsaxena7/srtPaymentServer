const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");

const app = express();
app.use(cors());

// Middleware to capture raw body for JSON
app.use(
  bodyParser.json({
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || "utf8");
    },
  })
);

// Middleware to capture raw body for URL-encoded data
app.use(
  bodyParser.urlencoded({
    extended: false,
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || "utf8");
    },
  })
);

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
  const data = `${response}/pg/v1/pay${secretKey}`; // Adjust endpoint as per your use case
  return crypto.createHash("sha256").update(data).digest("hex");
}

app.post("/phonepe/callback", (req, res) => {
  console.log("Received callback from PhonePe");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  console.log("Raw Body:", req.rawBody);

  const responseString = req.body.response;

  if (!responseString) {
    console.error("Missing response in body");
    return res.status(400).send("Invalid request");
  }

  const xVerifyHeader = req.headers["x-verify"];

  if (!xVerifyHeader) {
    console.error("Missing x-verify header");
    return res.status(400).send("Invalid request");
  }

  // Split x-verify header to extract signature and salt index
  const [signature, saltIndex] = xVerifyHeader.split("###");

  // Use the appropriate secretKey based on saltIndex
  const secretKey = "6362bd9f-17b6-4eb2-b030-1ebbb78ce518"; // Replace with your actual salt key

  const expectedSignature = computeSignature(responseString, secretKey);


  const decodedData = Buffer.from(responseString, "base64").toString("utf-8");
  let paymentData;
  try {
    paymentData = JSON.parse(decodedData);
    console.log("Parsed Payment Data:", paymentData);
  } catch (error) {
    console.error("Error parsing JSON:", error);
    return res.status(400).send("Invalid response data");
  }

  // Extract transactionId and status
  const transactionId =
    paymentData.merchantTransactionId || paymentData.transactionId;
  const status =
    paymentData.status ||
    (paymentData.data ? paymentData.data.paymentState : null);

  if (!transactionId || !status) {
    console.error("Missing transactionId or status in paymentData");
    return res.status(400).send("Invalid payment data");
  }

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
