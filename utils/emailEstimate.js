import api from './api';
import { blobToBase64 } from './pdfToBase64';

export async function sendEstimateEmail(estimateId, pdfBlob, overrides = {}) {
  const pdf_base64 = await blobToBase64(pdfBlob);
  const payload = { pdf_base64, ...overrides };
  const { data } = await api.post(`/api/estimates/${estimateId}/email`, payload);
  return data;
}
