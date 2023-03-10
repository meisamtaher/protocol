import { ethers } from "ethers";

export const encodeFunctionCall = (to: string, payload: string, value = ethers.constants.Zero) => {
  const bytes = Buffer.from(payload.slice(2), "hex");
  return ethers.utils.solidityPack(
    ["address", "uint96", "uint32", "bytes"],
    [to, value, bytes.length, bytes]
  );
};
export interface ZapperContractCall {
  comment: string;
  to: string;
  payload: string;
}
