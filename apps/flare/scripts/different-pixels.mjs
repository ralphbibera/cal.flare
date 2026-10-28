export async function differentPixels([expected, actual]) {
  const pixels = async (bytes) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    image.close();
    return { width: canvas.width, height: canvas.height, data };
  };
  const left = await pixels(expected);
  const right = await pixels(actual);
  if (left.width !== right.width || left.height !== right.height) return Infinity;
  let count = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (left.data[offset + channel] !== right.data[offset + channel]) {
        count++;
        break;
      }
    }
  }
  return count;
}
