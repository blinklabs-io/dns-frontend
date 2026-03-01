import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import transactionRoutes from "./routes/transactionRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/transactions", transactionRoutes);

const parsedPort = parseInt(process.env.PORT || "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const HOST = process.env.BIND_HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Express server running on ${HOST}:${PORT}`);
});
