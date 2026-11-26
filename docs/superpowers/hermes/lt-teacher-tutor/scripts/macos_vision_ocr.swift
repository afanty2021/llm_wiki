// macOS Vision 框架整页 OCR（英文课本照片实测良好，约 6 秒/页）
// 用法: swift macos_vision_ocr.swift /path/to/image.jpg
import Foundation
import Vision

guard CommandLine.arguments.count > 1 else {
    print("usage: swift macos_vision_ocr.swift <image>")
    exit(1)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest { (request, error) in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    for obs in observations {
        if let top = obs.topCandidates(1).first {
            print(top.string)
        }
    }
}
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(url: url, options: [:])
try? handler.perform([request])
