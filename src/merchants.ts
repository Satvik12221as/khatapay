export interface Merchant { id: string; name: string; typicalCents: number }

// Demo shops. Later phases load these from the database.
export const MERCHANTS: Merchant[] = [
  { id: "shop1", name: "Lakshmi Provision Store", typicalCents: 12000 },
  { id: "shop2", name: "Green Leaf Organics", typicalCents: 8000 },
];