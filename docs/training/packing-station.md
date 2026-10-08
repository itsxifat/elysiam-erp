# The packing station

For the warehouse team and whoever packs parcels. Console → **Orders → Pack**.

## Packing an order

1. Scan the order slip's QR code, or type the order number and press Enter.
2. The screen lists every item on the order and how many pieces each needs.
3. Scan each piece's sticker. Every good scan ticks one piece.
   - A piece that is not on the order, the wrong size or colour, or one piece too many sounds
     an error and is not counted. Put it back and scan the right one.
   - A piece put in by mistake can be taken out of the list before the order is finished.
4. When every piece is in, close the box and scan the order slip again or press **Finish
   packing**. The order becomes **Packed**, and the courier label and invoice are ready to
   print.

Who packed, when, and every scan are kept with the order.

## The packing video

- While an order is open on the station, the camera over the table records. The order number,
  the date and time and the packer's name are written onto the picture.
- The video uploads by itself when the order is finished. If the network drops, the browser
  keeps it and tries again; the order page shows a video still waiting.
- The order page plays the video. Admins and the warehouse can watch any; a sales agent can
  watch the videos of their own orders.
- A video is kept until **seven days after the order is delivered** (or returned or cancelled),
  then deleted automatically.

## Setting up a desk

- A USB webcam pointing down at the table works best. A phone cannot scan with its camera and
  record at the same time.
- The first time, the browser asks to use the camera: allow it. Choose the camera on the
  station if the computer has more than one.
- An admin can turn recording off for the brand on the station's settings.

## An IP camera over the table (M38c)

Instead of a webcam on the packing computer, an IP camera on the shop's network can film the
table. The ERP's server records it; the browser does not.

### Setting it up (an admin, once per camera)

1. Find the camera's stream address and its user name and password (the camera's own app shows
   them; Tapo cameras call it a "camera account"). For example
   `rtsp://192.168.20.111:554/stream1`.
2. Console → **Orders → Pack → Settings → IP cameras → Add camera**.
3. Give it a name the packers will recognise ("Packing table 1"), paste the address **without**
   the user name and password in it, then type the user name and the password in their own
   boxes. Leave **Record with this camera** ticked and save.
4. Within a few seconds the list shows **Ready**. **Offline** with a reason means the server
   cannot get pictures:
   - _The camera refused the user name or password_: check the camera account.
   - _The server cannot reach the camera on the network_: check the address, and that the camera
     is on the same network as the server.
   - _The camera has no stream at that address_: check the path (`/stream1`, `/stream2`, …).
5. The password is never shown again: the list says it is set and shows a short fingerprint.
   To change it, edit the camera and type the new one; leave the box empty to keep it. Never
   send the camera's password in a chat or an email: type it into the settings only.

`/stream1` is the camera's full picture (about 15 MB a minute). If videos are too large,
`/stream2` (the smaller picture, about a tenth of that) can be entered instead.

### Packing with it

1. On the station, choose the camera under **Recording source** (once; the browser remembers).
2. Scan the order slip: the camera card says **Camera ready**.
3. Scan the pieces. Recording starts with the **first piece that belongs to the order**, from
   two seconds before that scan. A wrong piece never starts it.
4. Finish the order as usual. The card says the video is being cut, then **Video saved**; it
   appears on the order page like any packing video (marked "IP camera") and is kept and
   deleted the same way.

A recording stops by itself after fifteen minutes. If the camera was offline, the order is still
packed and its video reads "Missing".

## When something goes wrong

- **"Not in this order"**: the sticker belongs to another product. Check the order.
- **"Wrong size or colour"**: the order has this product, but another variant of it.
- **"One too many"**: that item already has all its pieces in the box. Do not pack the extra.
- **"Unknown code"**: scan the sticker on the piece itself, not the box or a label.
- **The camera does not start**: check the browser's camera permission for the ERP's address,
  and that no other program is using the camera.
