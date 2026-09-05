#!/usr/bin/env python3
"""Atomically exchange two existing directories on one Linux filesystem."""
from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

AT_FDCWD = -100
RENAME_EXCHANGE = 2


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: atomic-exchange-directories.py CANDIDATE CURRENT")
    candidate = Path(sys.argv[1]).resolve()
    current = Path(sys.argv[2]).resolve()
    if not candidate.is_dir() or not current.is_dir():
        raise SystemExit("both exchange paths must be existing directories")
    if candidate.stat().st_dev != current.stat().st_dev:
        raise SystemExit("exchange paths must be on the same filesystem")

    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise SystemExit("renameat2 is unavailable; refusing non-atomic directory exchange")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    if (
        renameat2(
            AT_FDCWD,
            os.fsencode(candidate),
            AT_FDCWD,
            os.fsencode(current),
            RENAME_EXCHANGE,
        )
        != 0
    ):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))

    parent_fd = os.open(current.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    print("status=exchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
