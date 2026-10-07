# Notices

## Project licence
The code is released under the MIT licence ([LICENSE](LICENSE)). Parts descend from an MIT-licensed project, "YouTube Automation Agent"; its copyright notice is kept in the licence file as the licence requires.

## Recorded Wikipedia and Wikimedia Commons responses (test fixtures)
The files in `scripts/fixtures/dark-history/` are recordings of responses from the public Wikipedia and Wikimedia Commons APIs, used so that tests run offline. They are **not** covered by the MIT licence:

- They contain text of the English Wikipedia articles "Mary Celeste" (https://en.wikipedia.org/wiki/Mary_Celeste) and "Tunguska event" (https://en.wikipedia.org/wiki/Tunguska_event). Wikipedia text is available under the Creative Commons Attribution-ShareAlike 4.0 licence (https://creativecommons.org/licenses/by-sa/4.0/); the authors are listed in each article's page history. The recordings are unmodified API responses stored as JSON.
- They contain metadata (titles, descriptions, authors, licence names) of files hosted on Wikimedia Commons. The licence and author of each file are inside the recordings and on each file's Commons description page. No image files are stored in this repository.

Copies and adaptations of these fixture files must keep this notice and the same licence (CC BY-SA 4.0).

## Content produced by the pipeline
Videos made from Wikipedia text and Commons images must credit the sources. The pipeline writes the credits (author, licence, URL for every image, and the Wikipedia article) into the video description. Share-alike obligations can apply to derivative works made with CC BY-SA material; the pipeline avoids such images when it can and flags the stories that still use one.

## Dependencies
Libraries are installed from npm under their own licences (mostly MIT, Apache-2.0, BSD and ISC). `ffmpeg-static` downloads an FFmpeg binary at install time (GPL-3.0-or-later); the binary is not part of this repository. Run `npm ls` and check each package's licence before redistributing a built bundle.

## Fonts
The optional local dashboard loads the Inter and JetBrains Mono fonts from the Google Fonts service (SIL Open Font License). No font files are stored in this repository.

## Text-to-speech voices (read before monetising)
No voice model is stored in this repository. `deploy/oracle-vm/install-piper.sh` can install the Piper text-to-speech engine and download a voice. Each voice has its own licence, set by the data it was trained on:

- The script's default is `en_US-ljspeech-high`: its Piper model card (https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD) lists the LJ Speech dataset as public domain and states no usage restriction. Check the current card before relying on it.
- `en_US-ryan-high` (not the default) lists its training dataset (RyanSpeech) under **CC BY-NC-SA 4.0** in the Piper project's model card (https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ryan/high/MODEL_CARD). "NC" means non-commercial. This project cannot tell you whether audio produced by the model is itself covered by that restriction; do not use this voice for monetised or commercial videos unless you have cleared it yourself.
- Voices whose model cards state more permissive terms, as of the time of writing: `en_US-joe-medium` (CC0), `en_US-libritts_r-medium` (CC BY 4.0, attribution needed), `en_GB-alba-medium` (CC BY 4.0, attribution needed). Check the current model card before relying on any of them.
- Set `PIPER_VOICE=<voice name>` when running the install script to choose another voice.
- Narration produced by hosted free-tier services (for example Gemini text-to-speech) is governed by that provider's terms, which are not reviewed here.
