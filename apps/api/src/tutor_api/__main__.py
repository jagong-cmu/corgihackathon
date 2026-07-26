"""uv run tutor-api"""

from __future__ import annotations

import os


def main() -> None:
    import uvicorn

    uvicorn.run(
        "tutor_api.app:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        reload=bool(os.environ.get("RELOAD")),
    )


if __name__ == "__main__":
    main()
