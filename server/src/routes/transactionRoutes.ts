import { Router } from "express";
import {
  createTransaction,
  submitTransaction,
  submitPartialTransaction,
  decodeUtxos,
  fetchAddressUtxos,
  planSldMint,
  planSldMintFull,
  buildSldMint,
  checkSldAvailability,
  fetchReferenceRefs,
  lookupTldOwner,
} from "../controllers/transactionController.js";

const router = Router();

router.post("/create", createTransaction);
router.post("/submit", submitTransaction);
router.post("/submit-partial", submitPartialTransaction);
router.post("/decode-utxos", decodeUtxos);
router.post("/address-utxos", fetchAddressUtxos);
router.post("/mint-sld/plan", planSldMint);
router.post("/mint-sld/plan/full", planSldMintFull);
router.post("/mint-sld/build", buildSldMint);
router.post("/mint-sld/check-availability", checkSldAvailability);
router.post("/reference-refs", fetchReferenceRefs);
router.get("/tld-owner/:csTld/:tldName", lookupTldOwner);

export default router;
