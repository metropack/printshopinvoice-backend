export async function blobToBase64(blob) {
  // Supports Blob, File, or Uint8Array/ArrayBuffer
  let realBlob = blob;
  if (blob instanceof Uint8Array) realBlob = new Blob([blob], { type: 'application/pdf' });
  if (blob instanceof ArrayBuffer) realBlob = new Blob([new Uint8Array(blob)], { type: 'application/pdf' });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result); // "data:application/pdf;base64,...."
    reader.readAsDataURL(realBlob);
  });
}
