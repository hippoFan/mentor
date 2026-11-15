# Licenses of the imported part data

Each `data/parts/<id>.json` has `license`, `source` (repo@commit:path) and `attribution` fields. Mentor's own code stays MIT;
the data files keep the license of the library they came from.

| Source | License | Files |
|---|---|---|
| [wokwi/wokwi-elements](https://github.com/wokwi/wokwi-elements) @ `5178c0c` | MIT, Copyright (c) 2019 Uri Shaked and contributors | arduino-uno, arduino-mega-2560, arduino-nano, esp32-devkit-v1, hc-sr04, dht22, servo-sg90, potentiometer, led-5mm, pushbutton-12mm, pushbutton-6mm, mpu6050 |
| [fritzing/fritzing-parts](https://github.com/fritzing/fritzing-parts) @ `27535f2` | **CC-BY-SA 3.0** (share-alike) | raspberry-pi-4, nodemcu-esp8266, breadboard-half |
| [wokwi/wokwi-boards](https://github.com/wokwi/wokwi-boards) @ `962b19d` | **No license file upstream** (GitHub reports none) | raspberry-pi-pico, raspberry-pi-pico-w, esp32-devkitc |

## wokwi-elements (MIT)
Permission is granted, free of charge, to use, copy, modify and distribute the software and associated files, provided the
copyright notice and permission notice are included. Only pin names and coordinates are extracted; no source code or artwork is copied.

## Fritzing (CC-BY-SA 3.0)
Connector names, descriptions and positions are derived from the Fritzing core parts (`core/*.fzp` and
`svg/core/breadboard/*.svg`), licensed under Creative Commons Attribution-ShareAlike 3.0
(https://creativecommons.org/licenses/by-sa/3.0/). Authors are credited per file (the `<author>` of the .fzp where present;
otherwise "Fritzing contributors"). Changes: converted SVG units to millimetres, re-anchored coordinates to the board outline, renamed pins to
the board's silkscreen labels (NodeMCU). **Share-alike:** these three JSON files (and any derivative of them) must stay CC-BY-SA 3.0.
They are data only and are kept separate from Mentor's MIT code.

## wokwi-boards (no explicit license)
The upstream repository has no LICENSE file. We use only the physical pin layout of the Raspberry Pi Pico and Espressif
ESP32-DevKitC (pin names and positions on the standard 0.1" grid, which are published facts of those boards), not Wokwi's SVG artwork
or descriptions. If this needs to be airtight before wider distribution, regenerate those three files from the official Raspberry Pi
Pico / Espressif datasheets or ask Wokwi to add a license; `license` is set to `unspecified` in the files to keep this visible.

## Arduino UNO Q (layout facts, no artwork)
The UNO Q (`uno-q`) has the UNO R3 outline, mounting holes and shield headers (datasheet section 12), so it reuses the
`arduino-uno` pin map (`data/uno-pins.json`); its power header's first hole is BOOT, and D20/D21 are SDA/SCL. Part
positions in `twin/pins.js` (`FEATURES['uno-q']`) and the 3.3 V logic notes in `circuit.mjs` / `twin/pins.js` are facts
read from Arduino's official documents (pinout pages are CC BY-SA 4.0; only names, voltages and approximate
millimetre positions were taken, no images or text):
- Datasheet ABX00162: https://docs.arduino.cc/resources/datasheets/ABX00162-datasheet.pdf (pin maps 9.3-9.7, LEDs, mechanical)
- Full pinout: https://docs.arduino.cc/resources/pinouts/ABX00162-full-pinout.pdf (top view p.1, LED matrix p.3)
- User manual, "UNO Q's main components": https://docs.arduino.cc/tutorials/uno-q/user-manual/
- Product page: https://docs.arduino.cc/hardware/uno-q/

## Not imported
L298N motor driver module: not present in wokwi-elements or Fritzing core (only bare L298 ICs).
