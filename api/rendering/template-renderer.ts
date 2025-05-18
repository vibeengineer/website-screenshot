import { Jimp, JimpMime } from "jimp";

export async function renderTemplate(
  content: Buffer,
  // biome-ignore lint/style/noNonNullAssertion: we parse env vars on server startup
  baseUrl: string = process.env.BASE_IMAGE_URL!,
  // biome-ignore lint/style/noNonNullAssertion: we parse env vars on server startup
  overlayUrl: string = process.env.OVERLAY_IMAGE_URL!
): Promise<Buffer> {
  const [base, shot, overlay] = await Promise.all([
    Jimp.read(baseUrl),
    Jimp.read(content),
    Jimp.read(overlayUrl),
  ]);

  const PAD_X = 108;
  const PAD_Y = 114;
  shot.resize({
    w: base.width - PAD_X * 2,
    h: base.height - PAD_Y * 2,
  });
  base.composite(shot, PAD_X, PAD_Y);
  base.composite(overlay, 0, 0);

  return base.getBuffer(JimpMime.png);
}
