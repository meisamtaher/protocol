import { ethers } from "ethers";

export interface ZapperContractCall {
  comment: string;
  to: string;
  payload: string;
}
