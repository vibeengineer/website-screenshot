import { Jimp, type JimpInstance, JimpMime } from "jimp";
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from "./constants";

async function loadImages(screenshotBuffer: Buffer, baseImageUrl: string, overlayImageUrl: string) {
  console.log("[jimpRenderer] Loading images...");
  return Promise.all([
    Jimp.read(baseImageUrl),
    Jimp.read(screenshotBuffer),
    Jimp.read(overlayImageUrl),
  ]);
}

function calculateDimensions(baseImage: Awaited<ReturnType<typeof Jimp.read>>) {
  const TEMPLATE_WIDTH = baseImage.width;
  const TEMPLATE_HEIGHT = baseImage.height;
  const CONTENT_WIDTH = TEMPLATE_WIDTH - 216;
  const CONTENT_HEIGHT = TEMPLATE_HEIGHT - 228;

  return {
    contentWidth: CONTENT_WIDTH,
    contentHeight: CONTENT_HEIGHT,
    horizontalPadding: 108,
    verticalPadding: 114,
  };
}

export async function putScreenshotInsideTemplate(
  screenshotBuffer: Buffer,
  baseImageUrl: string,
  overlayImageUrl: string
): Promise<Buffer> {
  try {
    const [baseImage, screenshotImage, overlayImage] = await loadImages(
      screenshotBuffer,
      baseImageUrl,
      overlayImageUrl
    );

    console.log("[jimpRenderer] Image dimensions loaded");

    const dimensions = calculateDimensions(baseImage);

    screenshotImage.resize({
      w: dimensions.contentWidth,
      h: dimensions.contentHeight,
    });

    baseImage.composite(screenshotImage, dimensions.horizontalPadding, dimensions.verticalPadding);
    baseImage.composite(overlayImage, 0, 0);

    return await baseImage.getBuffer(JimpMime.png);
  } catch (error) {
    console.error("Error rendering styled screenshot with Jimp:", error);
    return screenshotBuffer;
  }
}
