# Files onto the TV's USB stick from your PC

`scripts/tessel-remote` copies videos from your computer into a folder on
the USB stick plugged into the TV, and lists what is there. It needs only
Developer Mode on the TV and no configuration on the PC.

```bash
scripts/tessel-remote tvs                                # Samsung TVs on your LAN
scripts/tessel-remote drives                             # USB drives in the TV
scripts/tessel-remote ls shows                           # like ls -lh
scripts/tessel-remote push shows/S02 ~/videos/Show\ S02E0*.mp4
scripts/tessel-remote mv "shows/Show S01E01 (1).mp4" "shows/Show S01E01.mp4"
scripts/tessel-remote rm -r shows/S01
```

```
  DRIVE  LABEL           PATH                      SIZE     FREE
  A      removable_sda1  /opt/media/USBDriveA1   500 GB    99 GB

total 1.4G   (99 GB free of 500 GB on A, /opt/media/USBDriveA1/shows)
-rw-   739M Aug  3 16:07 Show S01E01.mp4
-rw-   743M Aug  3 16:08 Show S01E02.mp4

→ [TV] Samsung 7 Series (65)  A/shows/S02  (99 GB free)
✓ Show S02E01.mp4 (745 MB) in 61s, 12.2 MB/s
```

## What you need

- **Node 22** or later on the PC.
- **Developer Mode** on the TV, with your PC's IP (Apps → `1 2 3 4 5` →
  Developer Mode on). You have this already if you sideloaded Tessel.
- **`sdb`**, the Tizen device tool, for one thing only: launching Tessel in
  debug mode. It comes with Tizen Studio; if it isn't on your `PATH`, point
  `--sdb` or `SDB=` at `tizen-studio/tools/sdb`.

## How it works, and what to expect

A Samsung TV accepts no incoming file transfers: no ssh, ftp or SMB, and
`sdb` can't write to the stick. Tessel can download files, though, so the
script serves your files over HTTP during the transfer and asks the
running app, via its DevTools socket, to download each one onto the stick.
The TV's download daemon does the writing, at the speed of the TV's network
connection (about 12 MB/s on a 2018 set on Wi-Fi: a 750 MB episode in a
minute).

For that socket Tessel has to run in debug mode. The first `drives`, `ls`
or `push` launches it that way through `sdb`, which **restarts the app** on
its start screen (a playing video stops). After that the app works
normally, and later runs reuse the open socket without restarting it,
until the app is closed. The TV is found by SSDP and remembered in
`~/.cache/tessel-remote.json`; if there are several TVs on the LAN,
choose one with `--tv <ip>` or `TESSEL_TV=`.

Files that are already on the stick with the same size are skipped, so a
run that was interrupted can simply be repeated. Each file's size on the
stick is checked after the download. A folder that doesn't exist is
created. Give it a few seconds before pulling the stick: the TV writes
through a cache.

## rm and mv

`rm <path>...` removes files; removing a folder and its contents needs
`-r`. `mv <from> <to>` renames, or moves into `<to>` when that is an
existing folder. Both check every path first and change nothing unless all
of them are fine: no removing a drive root, no overwriting, no moving a
folder into itself, no moving between two sticks (the TV would copy), no
`..` in a path. Quote names with spaces as you would for any shell command;
non-ASCII names are passed through as they are.

Tessel keeps watched state and resume positions by file path, so a moved
or renamed episode starts fresh in the USB browser.

## Two sticks

`push shows/S02 …` goes to the stick that already has `shows/` at its
root. If neither or both do, the script stops and prints `drives`; say
which with `-d B` or a prefix, `B/shows/S02`. Drive letters follow the
TV's own order, so a stick can change letter after a replug. Rely on the
folder rule instead.
