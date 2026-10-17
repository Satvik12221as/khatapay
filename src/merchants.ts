export interface Loyalty { visits: number; memberSince: string; onTimeRate: number }
export interface Merchant {
  id: string;
  name: string;
  typicalCents: number;
  maxDiscountPct: number; // the shop's hard limit for any discount
  loyalty: Loyalty;       // demo customer's history at this shop
}

// Demo shops. Later phases load these from the database.
export const MERCHANTS: Merchant[] = [
  { id: "shop1", name: "Lakshmi Provision Store", typicalCents: 12000, maxDiscountPct: 10, loyalty: { visits: 14, memberSince: "March", onTimeRate: 1 } },
  { id: "shop2", name: "Green Leaf Organics", typicalCents: 8000, maxDiscountPct: 5, loyalty: { visits: 2, memberSince: "September", onTimeRate: 1 } },
];