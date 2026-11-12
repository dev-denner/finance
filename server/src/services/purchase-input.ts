/** Modelo normalizado compartilhado pelos adaptadores estaduais de NFC-e. */
export interface PurchaseItemInput {
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  discountCents: number | null;
  totalCents: number;
}

export interface PurchaseInput {
  accessKey: string;
  supplierName: string;
  supplierCnpj: string;
  invoiceNumber: string;
  series: string;
  issuedAt: string;
  totalCents: number;
  invoiceDiscountCents: number;
  paymentMethod: string | null;
  items: PurchaseItemInput[];
}
