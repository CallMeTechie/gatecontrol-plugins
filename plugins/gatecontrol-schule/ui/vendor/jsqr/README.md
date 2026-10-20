# jsQR 1.4.0 (vendored)

`jsQR.js` is `dist/jsQR.js` of the npm package [jsqr@1.4.0](https://github.com/cozmo/jsQR)
(Cosmo Wolfe, Jefff Nelson), unchanged, under the Apache License 2.0 (`LICENSE`).

The Schule plugin uses it to read the WebUntis QR code from the camera or from an uploaded
picture in browsers without `BarcodeDetector`. It is not inlined into the pages: a frame asks
the plugin for it (`GET qr-decoder`) only when needed and runs it as an inline script.
