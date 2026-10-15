#!/usr/bin/env python3
"""Copy a site's login cookies from a Firefox-family profile (Zen) into one of Study Bridge's
embedded-view partitions, so an already-logged-in site does not have to be logged into twice.

Chromium and Firefox store cookies in unrelated formats, so this is a translation, not a copy:
  * Firefox keeps `moz_cookies.expiry` in MILLISECONDS since the Unix epoch, and lets a cookie
    carry a plaintext value. Chromium wants MICROSECONDS since 1601-01-01, and reads a plaintext
    `value` only when `encrypted_value` is empty -- which is exactly what we write, so no OS
    keyring is involved and nothing has to be decrypted.
  * Firefox's sameSite (0=none, 1=lax, 2=strict) is not Chromium's (-1=unspecified, 0=none,
    1=lax, 2=strict). This writes -1 unless the mapping is unambiguous: a "none" cookie must be
    Secure to be accepted, and Firefox will happily store one that is not.

Cookie VALUES are credentials. This prints names and counts only, never values.

Run with the app CLOSED -- the target database is locked while Electron holds it.
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import sqlite3
import subprocess
import sys
import time

CHROMIUM_EPOCH_OFFSET_S = 11644473600          # seconds between 1601-01-01 and 1970-01-01
STATE_DIR = os.path.expanduser('~/.local/state/study-bridge')
PARTITIONS = os.path.join(STATE_DIR, 'electron', 'Partitions')


def find_zen_profile(explicit: str | None) -> str:
    if explicit:
        return explicit
    base = os.path.expanduser('~/.config/zen')
    candidates = [d for d in glob.glob(os.path.join(base, '*'))
                  if os.path.exists(os.path.join(d, 'cookies.sqlite'))]
    if not candidates:
        sys.exit(f'no Zen profile with a cookies.sqlite under {base}; pass --from')
    return max(candidates, key=lambda d: os.path.getmtime(os.path.join(d, 'cookies.sqlite')))


def app_running() -> bool:
    r = subprocess.run(['pgrep', '-f', r'study-bridge/node_modules/.bin/electron|Study Bridge-.*AppImage'],
                       capture_output=True, text=True)
    return bool(r.stdout.strip())


def to_chromium_time(unix_ms: int) -> int:
    return int((unix_ms / 1000 + CHROMIUM_EPOCH_OFFSET_S) * 1_000_000)


def decode_samesite(firefox_value: int, is_secure: int) -> int:
    # 'none' demands Secure in Chromium; downgrade to unspecified rather than write a cookie
    # that will be silently dropped.
    return {1: 1, 2: 2}.get(firefox_value, -1 if not is_secure else 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--domain', default='arena.ai', help='site whose cookies to copy')
    ap.add_argument('--to', default='study-bridge-arena', help='target Electron partition name')
    ap.add_argument('--from', dest='src', default=None, help='Zen profile dir (default: newest)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    profile = find_zen_profile(args.src)
    target = os.path.join(PARTITIONS, args.to, 'Cookies')
    print(f'来源: {profile}')
    print(f'目标: {target}')

    if not os.path.exists(target):
        sys.exit(f'目标不存在 —— 先在应用里打开一次对应的标签页，让 Electron 建好这个分区\n  ({target})')
    if app_running():
        sys.exit('Study Bridge 正在运行，数据库被占用。先关掉应用再跑。')

    # Copy the source first: Firefox keeps recent writes in a -wal sidecar.
    tmp = '/tmp/sb-import-src.sqlite'
    shutil.copy2(os.path.join(profile, 'cookies.sqlite'), tmp)
    for side in ('-wal', '-shm'):
        s = os.path.join(profile, 'cookies.sqlite' + side)
        if os.path.exists(s):
            shutil.copy2(s, tmp + side)

    src = sqlite3.connect(f'file:{tmp}?mode=ro', uri=True)
    rows = src.execute("""
        SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
        FROM moz_cookies WHERE host LIKE ?
    """, (f'%{args.domain}',)).fetchall()
    src.close()
    if not rows:
        sys.exit(f'Zen 里没有 {args.domain} 的 cookie —— 先在 Zen 里登录一次')

    now = to_chromium_time(int(time.time() * 1000))
    fresh = [r for r in rows if not r[4] or r[4] > time.time() * 1000]
    print(f'待导入 {len(fresh)} 条（共命中 {len(rows)}，已跳过过期 {len(rows) - len(fresh)}）')

    if args.dry_run:
        for host, name, _v, _p, _e, sec, ho, ss in fresh:
            print(f'  [dry] {host:24} {name:34} secure={sec} httponly={ho}')
        return 0

    dst = sqlite3.connect(target)
    n = 0
    for host, name, value, path, expiry, is_secure, is_httponly, same_site in fresh:
        dst.execute("""
            INSERT OR REPLACE INTO cookies
              (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path,
               expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent,
               priority, samesite, source_scheme, source_port, last_update_utc, source_type,
               has_cross_site_ancestor)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            now, host, '', name, value, b'', path or '/',
            to_chromium_time(expiry) if expiry else 0,
            1 if is_secure else 0, 1 if is_httponly else 0, now,
            1 if expiry else 0, 1 if expiry else 0,
            1, decode_samesite(same_site, is_secure), 2, 443, now, 0, 0,
        ))
        n += 1
    dst.commit()
    total = dst.execute('SELECT count(*) FROM cookies').fetchone()[0]
    dst.close()
    os.unlink(tmp)
    for side in ('-wal', '-shm'):
        if os.path.exists(tmp + side):
            os.unlink(tmp + side)

    print(f'写入 {n} 条；该分区现有 {total} 条。')
    print('现在启动 Study Bridge，切到对应标签页看是否已登录。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
