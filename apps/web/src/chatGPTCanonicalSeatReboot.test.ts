import { describe, expect, it, vi } from "vite-plus/test";
import { canonicalSeatReboot } from "./chatGPTCanonicalSeatReboot";
const seatId="11111111-1111-4111-8111-111111111111";
const sessionId="22222222-2222-4222-8222-222222222222";
const requestId="33333333-3333-4333-8333-333333333333";
const receipt={version:1 as const,operation:"reboot_agent" as const,seatId,sessionId,requestId,
  managedSessionId:"44444444-4444-4444-8444-444444444444",rebootGeneration:null,
  status:"submitted" as const,reason:null,retrySafe:false as const};
const store=() => {
  const values=new Map<string,string>();
  return { getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);} };
};
describe("canonical managed same-seat reboot journal",()=>{
  it("persists exact request before begin and reconciles without duplicate begin",async()=>{
    const storage=store();
    const inv=vi.fn(async(input:{phase:string})=>({...receipt,status:input.phase==="reconcile"?"committed":"submitted"} as typeof receipt));
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId});
    expect(inv).toHaveBeenCalledTimes(1);
    expect(inv.mock.calls[0]![0].phase).toBe("begin");
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>{throw Error("duplicate create");}});
    expect(inv.mock.calls.map(v=>v[0].phase)).toEqual(["begin","status","reconcile"]);
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId});
    expect(inv.mock.calls.at(-1)![0].phase).toBe("begin");
  });
  it("after an UNKNOWN first dispatch, looks up exact ID without another begin",async()=>{
    const storage=store();
    const inv=vi.fn().mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce({...receipt,status:"unknown"})
      .mockResolvedValueOnce({...receipt,status:"committed"});
    await expect(canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId})).rejects.toThrow("lost reply");
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId});
    expect(inv.mock.calls.map(v=>v[0].phase)).toEqual(["begin","status","reconcile"]);
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId});
    expect(inv.mock.calls.at(-1)![0].phase).toBe("begin");
  });
  it("releases only a provably pre-dispatch authorization failure", async () => {
    const storage = store();
    const inv = vi.fn().mockRejectedValueOnce(
      new Error("OpenRig reboot pre-dispatch authorization rejected (HTTP 401); no operation was sent"),
    ).mockResolvedValue(receipt);
    await expect(canonicalSeatReboot({ seatId, sessionId, storage, invoke: inv, createId: () => requestId }))
      .rejects.toThrow("pre-dispatch authorization rejected");
    await canonicalSeatReboot({ seatId, sessionId, storage, invoke: inv, createId: () => requestId });
    expect(inv.mock.calls.map(v => v[0].phase)).toEqual(["begin", "begin"]);
  });  it("refuses seat changes for the same stable browser session",async()=>{
    const storage=store();const inv=vi.fn().mockResolvedValue(receipt);
    await canonicalSeatReboot({seatId,sessionId,storage,invoke:inv,createId:()=>requestId});
    await expect(canonicalSeatReboot({seatId:sessionId,sessionId,storage,invoke:inv})).rejects.toThrow("seat changed");
    expect(inv).toHaveBeenCalledTimes(1);
  });
});
