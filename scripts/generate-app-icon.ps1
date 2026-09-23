param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\resources')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

function New-LabDeckPngBytes {
  param([int]$Size)

  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $scale = $Size / 256.0
  $bounds = New-Object System.Drawing.RectangleF((10 * $scale), (10 * $scale), (236 * $scale), (236 * $scale))
  $radius = 54 * $scale
  $diameter = $radius * 2
  $surface = New-Object System.Drawing.Drawing2D.GraphicsPath
  $surface.AddArc($bounds.X, $bounds.Y, $diameter, $diameter, 180, 90)
  $surface.AddArc($bounds.Right - $diameter, $bounds.Y, $diameter, $diameter, 270, 90)
  $surface.AddArc($bounds.Right - $diameter, $bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $surface.AddArc($bounds.X, $bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $surface.CloseFigure()

  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $bounds,
    [System.Drawing.ColorTranslator]::FromHtml('#173F3D'),
    [System.Drawing.ColorTranslator]::FromHtml('#0B2428'),
    48
  )
  $graphics.FillPath($gradient, $surface)
  $borderPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#4FB8AD'), [Math]::Max(1, 2 * $scale))
  $graphics.DrawPath($borderPen, $surface)

  $mainPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#F2FAF8'), [Math]::Max(1.5, 18 * $scale))
  $mainPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $mainPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $mainPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLine($mainPen, 70 * $scale, 58 * $scale, 70 * $scale, 198 * $scale)
  $graphics.DrawLine($mainPen, 70 * $scale, 198 * $scale, 122 * $scale, 198 * $scale)

  $deckPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $deckPath.StartFigure()
  $deckPath.AddLine(111 * $scale, 58 * $scale, 133 * $scale, 58 * $scale)
  $deckPath.AddBezier(133 * $scale, 58 * $scale, 172 * $scale, 58 * $scale, 195 * $scale, 85 * $scale, 195 * $scale, 128 * $scale)
  $deckPath.AddBezier(195 * $scale, 128 * $scale, 195 * $scale, 171 * $scale, 172 * $scale, 198 * $scale, 133 * $scale, 198 * $scale)
  $deckPath.AddLine(133 * $scale, 198 * $scale, 111 * $scale, 198 * $scale)
  $deckPath.AddLine(111 * $scale, 198 * $scale, 111 * $scale, 58 * $scale)
  $graphics.DrawPath($mainPen, $deckPath)

  $accentPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#62D3C4'), [Math]::Max(1, 10 * $scale))
  $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($accentPen, 137 * $scale, 91 * $scale, 173 * $scale, 91 * $scale)
  $graphics.DrawLine($accentPen, 137 * $scale, 128 * $scale, 179 * $scale, 128 * $scale)
  $graphics.DrawLine($accentPen, 137 * $scale, 165 * $scale, 173 * $scale, 165 * $scale)

  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()

  $stream.Dispose()
  $accentPen.Dispose()
  $deckPath.Dispose()
  $mainPen.Dispose()
  $borderPen.Dispose()
  $gradient.Dispose()
  $surface.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  return $bytes
}

function Convert-PngToIconDib {
  param(
    [byte[]]$PngBytes,
    [int]$Size
  )

  $pngStream = New-Object System.IO.MemoryStream(,$PngBytes)
  $bitmap = New-Object System.Drawing.Bitmap($pngStream)
  $dibStream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($dibStream)
  $maskRowBytes = [int]([Math]::Ceiling($Size / 32.0) * 4)
  $pixelBytes = $Size * $Size * 4
  $maskBytes = $maskRowBytes * $Size

  $writer.Write([UInt32]40)
  $writer.Write([Int32]$Size)
  $writer.Write([Int32]($Size * 2))
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]($pixelBytes + $maskBytes))
  $writer.Write([Int32]0)
  $writer.Write([Int32]0)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]0)

  for ($y = $Size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $Size; $x++) {
      $pixel = $bitmap.GetPixel($x, $y)
      $writer.Write([Byte]$pixel.B)
      $writer.Write([Byte]$pixel.G)
      $writer.Write([Byte]$pixel.R)
      $writer.Write([Byte]$pixel.A)
    }
  }

  $mask = New-Object byte[] $maskBytes
  $writer.Write($mask)
  $bytes = $dibStream.ToArray()

  $writer.Dispose()
  $dibStream.Dispose()
  $bitmap.Dispose()
  $pngStream.Dispose()
  return $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  $images += ,(New-LabDeckPngBytes -Size $size)
}
$iconImages = @()
for ($index = 0; $index -lt $sizes.Count; $index++) {
  $iconImages += ,(Convert-PngToIconDib -PngBytes $images[$index] -Size $sizes[$index])
}

[System.IO.File]::WriteAllBytes((Join-Path $outputPath 'labdeck-icon.png'), $images[$images.Count - 1])

$iconPath = Join-Path $outputPath 'labdeck-icon.ico'
$stream = [System.IO.File]::Create($iconPath)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$iconImages.Count)
$offset = 6 + (16 * $iconImages.Count)
for ($index = 0; $index -lt $iconImages.Count; $index++) {
  $size = $sizes[$index]
  $writer.Write([Byte]($(if ($size -eq 256) { 0 } else { $size })))
  $writer.Write([Byte]($(if ($size -eq 256) { 0 } else { $size })))
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$iconImages[$index].Length)
  $writer.Write([UInt32]$offset)
  $offset += $iconImages[$index].Length
}
foreach ($image in $iconImages) {
  $writer.Write([byte[]]$image)
}
$writer.Dispose()
$stream.Dispose()

Write-Output "Generated $iconPath"
