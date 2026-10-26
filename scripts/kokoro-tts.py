#!/usr/bin/env python3
"""Kokoro-82M narration (Apache-2.0 model, kokoro-onnx MIT). Same contract as the Piper command:
   kokoro-tts.py --model-dir DIR --voice am_adam --input-file text.txt -f out.wav
DIR holds kokoro-v1.0.onnx and voices-v1.0.bin (GitHub release "model-files-v1.0" of kokoro-onnx). Runs on CPU, no network."""
import argparse
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', default=os.environ.get('KOKORO_DIR', ''))
parser.add_argument('--voice', required=True)
parser.add_argument('--input-file', required=True)
parser.add_argument('-f', '--output', required=True)
args = parser.parse_args()

with open(args.input_file, encoding='utf-8') as handle:
    text = handle.read().strip()
if not text:
    sys.exit('empty narration text')
model = os.path.join(args.model_dir, 'kokoro-v1.0.onnx')
voices = os.path.join(args.model_dir, 'voices-v1.0.bin')
for path in (model, voices):
    if not os.path.isfile(path):
        sys.exit('missing ' + path)
samples, rate = Kokoro(model, voices).create(text, voice=args.voice, speed=1.0, lang='en-gb' if args.voice.startswith('b') else 'en-us')
sf.write(args.output, samples, rate)
