"""Build BatikCode application icons from the transparent master artwork."""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "resources" / "batikcode-logo-transparent.png"
INNO_SIZES = {
	"big": {
		100: (164, 314),
		125: (192, 386),
		150: (246, 459),
		175: (273, 556),
		200: (328, 604),
		225: (355, 700),
		250: (410, 797),
	},
	"small": {
		100: (55, 55),
		125: (64, 68),
		150: (83, 80),
		175: (92, 97),
		200: (110, 106),
		225: (119, 123),
		250: (138, 140),
	},
}


def remove_magenta_spill(source: Image.Image) -> Image.Image:
	"""Neutralize chroma-key residue without changing the blue/cyan artwork."""
	image = source.copy()
	pixels = image.load()

	for y in range(image.height):
		for x in range(image.width):
			red, green, blue, alpha = pixels[x, y]
			if alpha and red > green + 35 and blue > green + 35:
				pixels[x, y] = (min(red, max(0, green - 1)), green, blue, alpha)

	return image


def square_master(size: int = 1024) -> Image.Image:
	source = remove_magenta_spill(Image.open(MASTER).convert("RGBA"))
	alpha = source.getchannel("A")
	bbox = alpha.getbbox()
	if not bbox:
		raise RuntimeError("The BatikCode master artwork has no visible pixels.")

	mark = source.crop(bbox)
	maximum = round(size * 0.78)
	mark.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
	canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
	return canvas


def save_png(image: Image.Image, path: Path, size: int) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	image.resize((size, size), Image.Resampling.LANCZOS).save(path, optimize=True)


def save_editor_watermark(source: Image.Image, path: Path) -> None:
	"""Create a quiet monochrome mark while retaining the batik detailing."""
	image = source.resize((512, 512), Image.Resampling.LANCZOS).convert("RGBA")
	pixels = image.load()

	for y in range(image.height):
		for x in range(image.width):
			red, green, blue, alpha = pixels[x, y]
			luminance = (red * 54 + green * 183 + blue * 19) // 256
			detail_alpha = round(alpha * (0.36 + 0.64 * luminance / 255))
			pixels[x, y] = (0, 0, 0, detail_alpha)

	path.parent.mkdir(parents=True, exist_ok=True)
	image.save(path, optimize=True)


def save_titlebar_icon(source: Image.Image, path: Path) -> None:
	"""Create a tightly framed icon that remains legible in the 20px title bar slot."""
	alpha = source.getchannel("A")
	bbox = alpha.getbbox()
	if not bbox:
		raise RuntimeError("The BatikCode title bar artwork has no visible pixels.")

	mark = source.crop(bbox)
	mark.thumbnail((58, 58), Image.Resampling.LANCZOS)
	canvas = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
	canvas.alpha_composite(mark, ((64 - mark.width) // 2, (64 - mark.height) // 2))
	path.parent.mkdir(parents=True, exist_ok=True)
	canvas.save(path, optimize=True)


def save_installer_bitmap(icon: Image.Image, path: Path, size: tuple[int, int], scale: float) -> None:
	width, height = size
	mark = icon.copy()
	maximum = round(min(width, height) * scale)
	mark.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)

	canvas = Image.new("RGB", size, (250, 250, 250))
	left = (width - mark.width) // 2
	top = max(0, round(height * 0.40 - mark.height / 2))
	canvas.paste(mark, (left, top), mark)
	canvas.save(path, format="BMP")


def main() -> None:
	icon = square_master()

	save_png(icon, ROOT / "resources" / "linux" / "code.png", 512)
	save_png(icon, ROOT / "resources" / "server" / "code-192.png", 192)
	save_png(icon, ROOT / "resources" / "server" / "code-512.png", 512)
	save_png(icon, ROOT / "resources" / "win32" / "code_70x70.png", 70)
	save_png(icon, ROOT / "resources" / "win32" / "code_150x150.png", 150)
	save_editor_watermark(
		icon,
		ROOT / "src" / "vs" / "workbench" / "browser" / "parts" / "editor" / "media" / "batikcode-letterpress.png",
	)
	save_titlebar_icon(
		icon,
		ROOT / "src" / "vs" / "workbench" / "browser" / "media" / "batikcode-titlebar.png",
	)

	icon.save(
		ROOT / "resources" / "win32" / "code.ico",
		format="ICO",
		sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
	)
	icon.save(
		ROOT / "resources" / "server" / "favicon.ico",
		format="ICO",
		sizes=[(16, 16), (32, 32), (48, 48)],
	)
	icon.save(
		ROOT / "resources" / "darwin" / "code.icns",
		format="ICNS",
	)

	for family, variants in INNO_SIZES.items():
		scale = 0.95
		for density, size in variants.items():
			save_installer_bitmap(
				icon,
				ROOT / "resources" / "win32" / f"inno-{family}-{density}.bmp",
				size,
				scale,
			)


if __name__ == "__main__":
	main()
