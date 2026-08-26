import "./patch-anchor.js";
import { assertNoVulnerableBigintBufferNativeBinding } from "./dependency-safety.js";

assertNoVulnerableBigintBufferNativeBinding();
console.log("Dependency safety: bigint-buffer JavaScript fallback verified");
