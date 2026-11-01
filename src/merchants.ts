export interface Loyalty { visits: number; memberSince: string; onTimeRate: number }
export interface History { completed: number; disputesLost: number; repeatCustomers: number }
export interface Merchant {
  id: string;
  name: string;
  typicalCents: number;
  maxDiscountPct: number; // the shop's hard limit for any discount
  loyalty: Loyalty;       // demo customer's history at this shop (used by the haggle agents)
  category: string;       // groceries | organic | sweets | bakery | dairy | household
  area: string;
  history: History;       // seeded demo history before today; live payments are added on top
}

// Demo shops. Later phases load these from the database.
export const MERCHANTS: Merchant[] = [
  { id: "shop1", name: "Lakshmi Provision Store", typicalCents: 12000, maxDiscountPct: 10, loyalty: { visits: 14, memberSince: "March", onTimeRate: 1 },
    category: "groceries", area: "Mylapore", history: { completed: 42, disputesLost: 1, repeatCustomers: 9 } },
  { id: "shop2", name: "Green Leaf Organics", typicalCents: 8000, maxDiscountPct: 5, loyalty: { visits: 2, memberSince: "September", onTimeRate: 1 },
    category: "organic", area: "Adyar", history: { completed: 8, disputesLost: 2, repeatCustomers: 1 } },
  { id: "shop3", name: "Annapurna Sweets", typicalCents: 6000, maxDiscountPct: 8, loyalty: { visits: 5, memberSince: "June", onTimeRate: 1 },
    category: "sweets", area: "T. Nagar", history: { completed: 0, disputesLost: 0, repeatCustomers: 0 } },
];