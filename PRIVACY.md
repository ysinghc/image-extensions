# ImageForge Privacy Policy

Last updated: 2026-11-12

ImageForge converts, resizes, and compresses images **entirely on your
device**. This policy describes the little data access involved.

## Data we collect

**None.** ImageForge has no servers, no analytics, no telemetry, and no
advertising. It does not collect, store, transmit, or sell any personal data.

## How your images are handled

- Images you upload, paste, or drop into the extension are processed locally
  in your browser's memory using the Canvas API. They are never sent anywhere.
- When **you** supply an image URL (or right-click an image and choose an
  ImageForge action), the extension fetches that URL directly — the same as
  your browser loading the image normally — converts it locally, and saves the
  result to your downloads folder.
- Downloaded files go through your browser's normal download flow.

## Permissions and why they're needed

| Permission | Why |
| ---------- | --- |
| `host_permissions: <all_urls>` | To fetch image URLs you explicitly provide, wherever they're hosted. |
| `contextMenus` | To add the right-click “ImageForge” actions on images. |
| `downloads` | To save converted images (used by the background quick-download). |
| `storage` | To hand an image from the popup to the editor tab (session only, deleted after use). |
| `clipboardRead` / `clipboardWrite` | To paste images in and copy results out. |

## Third parties

No data is shared with any third party, because no data leaves your device
except the image fetches you initiate.

## Contact

Open an issue at <https://github.com/ysinghc/image-extensions/issues>.
