# Third-party models and runtimes

Weights are not committed; `npm run fetch-models` downloads them pinned to an exact commit and checks sha256.

## Depth Anything V2 Small

- File: `depth-anything-v2-small.int8.onnx` (int8-quantized ONNX export, 27.3 MB)
- License: Apache-2.0. Only the **Small** checkpoint is Apache-2.0; Base/Large/Giant are CC-BY-NC-4.0 and are not used.
- Authors: Lihe Yang, Bingyi Kang, Zilong Huang, Zhen Zhao, Xiaogang Xu, Jiashi Feng, Hengshuang Zhao,
  "Depth Anything V2" (NeurIPS 2024, arXiv:2406.09414).
- Source: https://github.com/DepthAnything/Depth-Anything-V2 , weights https://huggingface.co/depth-anything/Depth-Anything-V2-Small
- ONNX conversion: onnx-community, https://huggingface.co/onnx-community/depth-anything-v2-small
  (commit `4472b7362082ad9968fee890ca0f1e5aca36b93d`, file `onnx/model_int8.onnx`,
  sha256 `01aa7a23de3f4a0ee1a2bb9997e6918104c85a9f95dea46d27b9b3fb0c6b9001`)

## onnxruntime-node

- npm `onnxruntime-node` 1.31.1, MIT License, Copyright (c) Microsoft Corporation.
- Source: https://github.com/microsoft/onnxruntime

## MediaPipe Interactive Segmenter: magic_touch.tflite (served from twin/models/)

- File: `twin/models/magic_touch.tflite` (6,227,884 bytes, sha256 `e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`)
- License: Apache-2.0, Copyright Google LLC. Run in the browser by `@mediapipe/tasks-vision` (Apache-2.0, `InteractiveSegmenterLegacy`).
- Source: https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite
  (MediaPipe docs: https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter)
