# Ody: privacy notice

*A hackathon prototype (HackUTA 2026). This is a plain-language notice of what Ody does with your data. It has not
been reviewed by a lawyer.*

## Before anything is processed
When you FaceTime Ody, it first tells you that the call is handled by AI and asks you to say **"yes"** to continue.
Until you agree:
- it sends **nothing** to an AI model,
- it saves **no** snapshots,
- it makes **no** scans.

If you say **"no"**, or hang up, nothing more is processed. You can say **"stop recording"** at any time to stop
snapshots for the rest of the call.

## What goes where during a call
| Data | Sent to | Why |
|---|---|---|
| Your FaceTime audio and video | **Chert** (FaceTime bridge) and **LiveKit Cloud** (real-time transport) | To connect the call to Ody |
| Your voice | **ElevenLabs** (speech-to-text) | To understand what you say |
| Ody's replies (text) | **ElevenLabs** (text-to-speech) | To speak back to you |
| A camera snapshot each time you finish speaking, or when you say "scan" | The AI model: **Google Gemini**, or **Anthropic Claude** during the owner's testing | To see what you're showing and decide where to point |
| After a scan: the scan photo and the object's name | The AI model (plus a web search for the model name, if turned on) | To identify the exact model and research what's inside it |

Each provider handles data under its own terms and privacy policy. Ody never sells data or uses it for ads.

## What stays on the laptop running Ody
- **Per call:** a snapshot of what Ody saw and what it showed back (every 3 s), your scans, and the transcript. These are
  kept in a local folder and deleted automatically after **7 days** (checked whenever Ody starts or a call begins).
- **The Forge (Argos, on the laptop page):** each scan from a call is also saved as a design (shape, OpenSCAD code and
  the scan photo) in a git-ignored `designs/` folder, and deleted after the same **7 days**. Nothing is saved after you
  say "stop recording" or "no". Argos's chat and refinements on the laptop send design names and code (never your
  photo) to the laptop's own model (Gemini by default); its record button sends the laptop user's voice to ElevenLabs.
- **Ody's working log:** a text log on the laptop that includes what was said. The team clears it after the event.
- **Recap page:** opened through a random link that expires after **24 hours**.
- **Laptop screen (the 3D twin):** local only. It accepts no connections from other computers or websites.
- **Hand control** uses the laptop's own camera, processed on the laptop. That video never leaves it.

## Security
- API keys live only in a local settings file that is never committed to the code repository.
- The local pages send strict security headers and check every request's origin.
- Text Ody sees on camera is treated as information, never as instructions.
- AI output is only ever words and screen positions. Nothing it returns is run as code.

## Your choices
- Say **"no"** at the start, or hang up, at any time.
- Say **"stop recording"** to stop snapshots for the rest of the call.
- Ask the team to delete your call. It is one folder on one laptop.

## Contact
Contact the Ody team at the HackUTA science fair, or through the GitHub repository's issues.
