import api from './api';
import { blobToBase64 } from './pdfToBase64';

// pdfBlob: the Blob/Uint8Array you generated for the invoice PDF
export async function sendInvoiceEmail(invoiceId, pdfBlob, overrides = {}) {
  const pdf_base64 = await blobToBase64(pdfBlob);

  // Optional overrides: { to, subject, message_html, message_text, reply_to }
  const payload = { pdf_base64, ...overrides };

  const { data } = await api.post(`/api/invoices/${invoiceId}/email`, payload);
  return data;
}
