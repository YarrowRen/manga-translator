import logging
import os
import sys
from functools import lru_cache

from core.config import settings


class ColoredFormatter(logging.Formatter):
    COLORS = {
        'DEBUG': '\033[36m',
        'INFO': '\033[32m',
        'WARNING': '\033[33m',
        'ERROR': '\033[31m',
        'CRITICAL': '\033[35m',
    }
    RESET = '\033[0m'

    def format(self, record):
        log_message = super().format(record)
        if hasattr(record, 'no_color') or not self._should_use_color():
            return log_message
        level_color = self.COLORS.get(record.levelname, '')
        if level_color:
            colored_level = f"{level_color}{record.levelname}{self.RESET}"
            log_message = log_message.replace(f"{record.levelname}:", f"{colored_level}:")
        return log_message

    def _should_use_color(self):
        if os.getenv('NO_COLOR'):
            return False
        if os.getenv('FORCE_COLOR'):
            return True
        return True


@lru_cache()
def get_logger(name: str = __name__) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(settings.LOG_LEVEL)

    colored_formatter = ColoredFormatter(
        "%(levelname)s:    [%(asctime)s] [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(colored_formatter)
    logger.addHandler(stream_handler)

    os.makedirs(settings.LOG_DIR, exist_ok=True)
    file_path = os.path.join(settings.LOG_DIR, settings.LOG_FILE)
    file_handler = logging.FileHandler(file_path, encoding="utf-8")
    file_handler.setFormatter(file_formatter)
    logger.addHandler(file_handler)

    return logger
