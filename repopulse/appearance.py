"""Page-wide look of the dashboard, set by the admin under Admin, Appearance.

Every option is a fixed list of words (the first is the default) or a colour, so
nothing a user types ends up in CSS as is. The frontend has the same lists in
static/js/appearance.js.
"""
from __future__ import annotations

import re
from typing import Any

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

CHOICES: dict[str, tuple[str, ...]] = {
    "theme": ("system", "light", "dark"),
    "palette": ("default", "vivid", "pastel", "ocean", "sunset", "forest", "berry", "mono", "grey"),
    "surface": ("neutral", "warm", "cool", "tinted", "contrast"),
    "background": ("plain", "gradient", "glow", "dots", "grid"),
    "radius": ("default", "sharp", "soft", "round"),
    "density": ("comfortable", "compact", "spacious"),
    "width": ("standard", "narrow", "wide", "full"),
    "font": ("default", "system", "serif", "mono", "rounded"),
    "cards": ("bordered", "shadow", "flat", "outline"),
    "headline": ("panel", "tint", "accent", "gradient"),
    "titles": ("normal", "caps", "large"),
    "motion": ("on", "off"),
    "brand": ("show", "hide"),
    "subtitle": ("show", "hide"),
    "rangebar": ("show", "hide"),
    "csv": ("show", "hide"),
    "default_range": ("30", "7", "90", "365", "0"),
}
COLORS = ("accent",)  # "" means the built-in colour

DEFAULTS: dict[str, str] = {**{k: v[0] for k, v in CHOICES.items()}, **{k: "" for k in COLORS}}


def clean(data: Any) -> dict[str, str]:
    """The stored appearance with defaults filled in; unknown or bad values fall back."""
    out = dict(DEFAULTS)
    if not isinstance(data, dict):
        return out
    for key, value in data.items():
        if key in CHOICES and str(value) in CHOICES[key]:
            out[key] = str(value)
        elif key in COLORS and isinstance(value, str) and (value == "" or HEX_COLOR.match(value)):
            out[key] = value.lower()
    return out


def validate(data: Any) -> str | None:
    """An error message for a request body that is not a valid appearance, else None."""
    if not isinstance(data, dict):
        return "Invalid appearance"
    for key, value in data.items():
        if key in CHOICES:
            if str(value) not in CHOICES[key]:
                return f"Unknown value for {key}"
        elif key in COLORS:
            if not isinstance(value, str) or not (value == "" or HEX_COLOR.match(value)):
                return f"{key} must be a colour like #2a78d6"
        else:
            return f"Unknown appearance option {key}"
    return None
