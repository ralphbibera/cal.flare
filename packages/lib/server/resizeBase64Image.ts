import jimp from "jimp";

export function isBase64Image(value: string): boolean {
  return /^data:image\/(png|jpe?g);base64,/i.test(value);
}

function getImageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

export async function resizeBase64Image(
  base64OrUrl: string,
  opts?: {
    maxSize?: number;
  }
) {
  if (!base64OrUrl.startsWith("data:")) {
    // might be a `https://` or something
    return base64OrUrl;
  }
  const mimeMatch = base64OrUrl.match(/^data:(\w+\/\w+);/);
  const mimetype = mimeMatch?.[1];
  if (!mimetype) {
    throw new Error(`Could not distinguish mimetype`);
  }
  const buffer = Buffer.from(base64OrUrl.replace(/^data:image\/\w+;base64,/, ""), "base64");

  const {
    // 96px is the height of the image on https://cal.com/peer
    maxSize = 96 * 4,
  } = opts ?? {};
  const size = getImageSize(buffer);
  if (size && Math.max(size.width, size.height) <= maxSize) {
    return base64OrUrl;
  }
  try {
    const image = await jimp.read(buffer);
    const currentSize = Math.max(image.getWidth(), image.getHeight());
    if (currentSize > maxSize) {
      image.resize(jimp.AUTO, maxSize);
    }
    const newBuffer = await image.getBufferAsync(mimetype);

    return `data:${mimetype};base64,${newBuffer.toString("base64")}`;
  } catch (error) {
    // Jimp's pngjs decoder relies on Node zlib and cannot run in workerd.
    console.error("Avatar resize failed; storing the original image", error);
    return base64OrUrl;
  }
}
