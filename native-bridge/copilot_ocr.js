/* global ObjC, $, Ref */
// 中文注释：仅识别宿主传入的任务目录图片，不联网、不读取浏览器状态。
ObjC.import('Vision');
ObjC.import('Foundation');
ObjC.import('ImageIO');
// eslint-disable-next-line no-unused-vars -- JXA由osascript调用run入口
function run(args) {
  if (args.length !== 1 || !args[0].startsWith('/'))
    throw Error('one absolute image path required');
  const manager = $.NSFileManager.defaultManager;
  if (!manager.fileExistsAtPath(args[0])) throw Error('image unavailable');
  const attributes = manager.attributesOfItemAtPathError(args[0], null);
  if (!attributes || ObjC.unwrap(attributes.objectForKey($.NSFileType)) !== 'NSFileTypeRegular')
    throw Error('image must be a regular file');
  if (Number(attributes.objectForKey($.NSFileSize)) > 2000000)
    throw Error('image exceeds OCR limit');
  const url = $.NSURL.fileURLWithPath(args[0]);
  const source = $.CGImageSourceCreateWithURL(url, null);
  const properties = $.CGImageSourceCopyPropertiesAtIndex(source, 0, null);
  const metadata = ObjC.deepUnwrap(ObjC.castRefToObject(properties));
  const width = Number(metadata.PixelWidth);
  const height = Number(metadata.PixelHeight);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16000000
  ) {
    throw Error('image exceeds 16 megapixels or metadata is invalid');
  }
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.recognitionLanguages = $(['en-US', 'zh-Hans', 'zh-Hant']);
  request.usesLanguageCorrection = true;
  const error = Ref();
  if (!handler.performRequestsError($([request]), error)) throw Error('OCR failed');
  const results = request.results;
  if (!results) return '[]';
  if (Number(results.count) > 1000) throw Error('OCR exceeds 1000 lines; crop the image');
  const rows = [];
  let length = 0;
  for (let i = 0; i < Number(results.count); i++) {
    const candidate = results.objectAtIndex(i).topCandidates(1).firstObject;
    if (!candidate) continue;
    const text = ObjC.unwrap(candidate.string);
    const confidence = Number(candidate.confidence);
    length += text.length;
    if (text.length > 12000 || length > 100000)
      throw Error('OCR text exceeds limit; crop the image');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      throw Error('OCR confidence invalid');
    const box = results.objectAtIndex(i).boundingBox;
    const x = Number(box.origin.x);
    const y = 1 - Number(box.origin.y) - Number(box.size.height);
    const width = Number(box.size.width);
    const height = Number(box.size.height);
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < -0.000001 ||
      y < -0.000001 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1.000001 ||
      y + height > 1.000001
    ) {
      throw Error('OCR bounding box invalid');
    }
    rows.push({ text, confidence, x: Math.max(0, x), y: Math.max(0, y), width, height });
  }
  return JSON.stringify(rows);
}
