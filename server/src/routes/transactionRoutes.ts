import { Router } from "express";
import {
  createTransaction,
  submitTransaction,
  decodeUtxos,
  fetchAddressUtxos,
  planSldMint,
  planSldMintFull,
  buildSldMint,
  fetchReferenceRefs,
} from "../controllers/transactionController.js";

const router = Router();

router.post("/create", createTransaction);
router.post("/submit", submitTransaction);
router.post("/decode-utxos", decodeUtxos);
router.post("/address-utxos", fetchAddressUtxos);
router.post("/mint-sld/plan", planSldMint);
router.post("/mint-sld/plan/full", planSldMintFull);
router.post("/mint-sld/build", buildSldMint);
router.post("/reference-refs", fetchReferenceRefs);

export default router;
