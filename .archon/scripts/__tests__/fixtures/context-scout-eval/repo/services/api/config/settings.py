"""Tunable defaults for list endpoints and background jobs."""

DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 200
EXPORT_BATCH_ROWS = 5_000
THUMBNAIL_SIZES = (64, 128, 512)
SEARCH_RESULT_LIMIT = 50
JOB_RETRY_DELAYS_SECONDS = (5, 30, 120, 600)


def page_size(requested: int | None) -> int:
    if requested is None or requested <= 0:
        return DEFAULT_PAGE_SIZE
    return min(requested, MAX_PAGE_SIZE)
