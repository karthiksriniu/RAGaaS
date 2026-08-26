import { describe, it, expect } from "vitest";
import { planTrunkUpdate } from "../livekitSip";

// The decision that decides whether a phone number rings. It got this wrong in
// production: matching a trunk by NAME alone meant a number already carried by
// a hand-made trunk looked absent, so the code tried to create a second trunk
// and LiveKit refused the lot -
//   Conflicting inbound SIP Trunks: "<new>" and "ST_DRqDf2f3Y6Z9" ...
// leaving the number unallowlisted as far as our code could tell.

const OURS = "mybizcare-staging-inbound";

describe("planTrunkUpdate", () => {
  it("does nothing when the number is already carried - whatever the trunk is called", () => {
    const trunks = [{ sipTrunkId: "ST_handmade", name: "made-in-the-console", numbers: ["+918071580825"] }];
    expect(planTrunkUpdate(trunks, OURS, "+918071580825")).toEqual({ action: "none", trunkId: "ST_handmade" });
  });

  it("prefers the carrying trunk over our own empty one, so it never creates a conflict", () => {
    const trunks = [
      { sipTrunkId: "ST_ours", name: OURS, numbers: ["+919999999999"] },
      { sipTrunkId: "ST_handmade", name: "other", numbers: ["+918071580825"] },
    ];
    expect(planTrunkUpdate(trunks, OURS, "+918071580825")).toEqual({ action: "none", trunkId: "ST_handmade" });
  });

  it("adds to our own trunk when nothing carries the number yet", () => {
    const trunks = [
      { sipTrunkId: "ST_ours", name: OURS, numbers: ["+919999999999"] },
      { sipTrunkId: "ST_other", name: "unrelated", numbers: ["+918888888888"] },
    ];
    expect(planTrunkUpdate(trunks, OURS, "+918071580825")).toEqual({ action: "add", trunkId: "ST_ours" });
  });

  it("creates one when there is nothing to extend", () => {
    expect(planTrunkUpdate([], OURS, "+918071580825")).toEqual({ action: "create" });
  });

  it("does not treat another environment's trunk as ours", () => {
    const trunks = [{ sipTrunkId: "ST_prod", name: "mybizcare-prod-inbound", numbers: ["+919999999999"] }];
    expect(planTrunkUpdate(trunks, OURS, "+918071580825")).toEqual({ action: "create" });
  });
});
