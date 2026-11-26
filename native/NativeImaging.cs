using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

internal static class NativeImaging
{
    internal static (int Width, int Height) Dimensions(JsonObject options, int bytes, int maximum = 28_000_000)
    {
        var width = (int)options["width"]!;
        var height = (int)options["height"]!;
        if (width <= 0 || height <= 0 || (long)width * height > maximum || (long)width * height * 4 != bytes)
            throw new InvalidDataException("Invalid RGBA image dimensions.");
        return (width, height);
    }

    internal static byte[] Mask(JsonObject options, byte[] data)
    {
        var (width, height) = Dimensions(options, data.Length);
        var mask = Enumerable.Repeat((byte)255, width * height).ToArray();
        var originX = (double?)options["left"] ?? 0;
        var originY = (double?)options["top"] ?? 0;
        var imageWidth = (double?)options["imageWidth"] ?? width;
        var imageHeight = (double?)options["imageHeight"] ?? height;
        if (imageWidth <= 0 || imageHeight <= 0 || !double.IsFinite(imageWidth + imageHeight + originX + originY))
            throw new InvalidDataException("Invalid mask coordinates.");
        foreach (var stroke in options["strokes"]?.AsArray() ?? [])
        {
            var radius = (double)stroke!["size"]! * Math.Min(imageWidth, imageHeight) / 2;
            var mode = (string)stroke["mode"]!;
            var points = stroke["points"]!.AsArray();
            if (!double.IsFinite(radius) || radius <= 0 || radius > 10000 || points.Count == 0 ||
                (mode != "erase" && mode != "restore")) throw new InvalidDataException("Invalid brush stroke.");
            for (var index = 0; index < points.Count; index++)
            {
                var a = points[Math.Max(0, index - 1)]!;
                var b = points[index]!;
                var ax = (double)a["x"]! * imageWidth - originX;
                var ay = (double)a["y"]! * imageHeight - originY;
                var bx = (double)b["x"]! * imageWidth - originX;
                var by = (double)b["y"]! * imageHeight - originY;
                if (!double.IsFinite(ax + ay + bx + by)) throw new InvalidDataException("Invalid brush coordinates.");
                var dx = bx - ax;
                var dy = by - ay;
                var squared = dx * dx + dy * dy;
                for (var y = Math.Max(0, (int)Math.Floor(Math.Min(ay, by) - radius - 1)); y < Math.Min(height, Math.Ceiling(Math.Max(ay, by) + radius + 1)); y++)
                for (var x = Math.Max(0, (int)Math.Floor(Math.Min(ax, bx) - radius - 1)); x < Math.Min(width, Math.Ceiling(Math.Max(ax, bx) + radius + 1)); x++)
                {
                    var t = squared == 0 ? 0 : Math.Clamp(((x + .5 - ax) * dx + (y + .5 - ay) * dy) / squared, 0, 1);
                    var distance = Math.Sqrt(Math.Pow(x + .5 - ax - t * dx, 2) + Math.Pow(y + .5 - ay - t * dy, 2));
                    var coverage = Math.Clamp(radius + .5 - distance, 0, 1);
                    var offset = y * width + x;
                    mask[offset] = (byte)Math.Round(mode == "erase" ? mask[offset] * (1 - coverage) : mask[offset] + (255 - mask[offset]) * coverage);
                }
            }
        }
        var expand = Math.Clamp((int?)options["expand"] ?? 0, -8, 8);
        if (expand != 0)
        {
            var source = (byte[])mask.Clone();
            var radius = Math.Abs(expand);
            for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var alpha = expand > 0 ? 0 : 255;
                if (expand < 0 && (x < radius || y < radius || x + radius >= width || y + radius >= height))
                    alpha = 0;
                for (var yy = Math.Max(0, y - radius); yy <= Math.Min(height - 1, y + radius); yy++)
                for (var xx = Math.Max(0, x - radius); xx <= Math.Min(width - 1, x + radius); xx++)
                    alpha = expand > 0 ? Math.Max(alpha, source[yy * width + xx]) : Math.Min(alpha, source[yy * width + xx]);
                mask[y * width + x] = (byte)alpha;
            }
        }
        for (var index = 0; index < mask.Length; index++)
            data[index * 4 + 3] = (byte)((data[index * 4 + 3] * mask[index] + 127) / 255);
        return data;
    }

    internal static (JsonObject, byte[]) Preprocess(JsonObject options, byte[] data)
    {
        var (width, height) = Dimensions(options, data.Length);
        var scale = Math.Clamp((int?)options["scale"] ?? 2, 1, 3);
        if ((long)width * height * scale * scale > 28_000_000) scale = 1;
        var gray = new byte[width * height];
        var histogram = new int[256];
        for (var index = 0; index < gray.Length; index++)
        {
            var offset = index * 4;
            var value = (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) / 256;
            gray[index] = (byte)((value * data[offset + 3] + 255 * (255 - data[offset + 3])) / 255);
            histogram[gray[index]]++;
        }
        var low = Percentile(.01);
        var high = Math.Max(low + 1, Percentile(.99));
        var denoise = (bool?)options["denoise"] ?? true;
        var output = new byte[width * height * scale * scale * 4];
        NativeProgress.Emit(5, "Chuẩn hóa độ tương phản");
        Span<byte> neighbors = stackalloc byte[5];
        for (var y = 0; y < height; y++)
        for (var x = 0; x < width; x++)
        {
            if (x == 0 && y % 64 == 0) NativeProgress.Emit(5 + 65d * y / height, "Lọc nhiễu và phóng ảnh");
            var value = (int)gray[y * width + x];
            if (denoise && x > 0 && y > 0 && x < width - 1 && y < height - 1)
            {
                neighbors[0] = gray[y * width + x - 1];
                neighbors[1] = gray[y * width + x + 1];
                neighbors[2] = gray[(y - 1) * width + x];
                neighbors[3] = gray[(y + 1) * width + x];
                neighbors[4] = (byte)value;
                neighbors.Sort();
                value = neighbors[2];
            }
            value = Math.Clamp((value - low) * 255 / (high - low), 0, 255);
            for (var sy = 0; sy < scale; sy++)
            for (var sx = 0; sx < scale; sx++)
            {
                var offset = (((y * scale + sy) * width * scale) + x * scale + sx) * 4;
                output[offset] = output[offset + 1] = output[offset + 2] = (byte)value;
                output[offset + 3] = 255;
            }
        }
        var outputWidth = width * scale;
        var outputHeight = height * scale;
        var rotation = (int?)options["rotation"] ?? 0;
        if (rotation is not (0 or 90 or 180 or 270)) throw new InvalidDataException("Invalid OCR rotation.");
        if (rotation != 0)
        {
            var rotated = new byte[output.Length];
            var rotatedWidth = rotation == 180 ? outputWidth : outputHeight;
            for (var y = 0; y < outputHeight; y++)
            for (var x = 0; x < outputWidth; x++)
            {
                var rx = rotation == 90 ? outputHeight - 1 - y : rotation == 180 ? outputWidth - 1 - x : y;
                var ry = rotation == 90 ? x : rotation == 180 ? outputHeight - 1 - y : outputWidth - 1 - x;
                output.AsSpan((y * outputWidth + x) * 4, 4).CopyTo(rotated.AsSpan((ry * rotatedWidth + rx) * 4));
            }
            output = rotated;
            if (rotation != 180) (outputWidth, outputHeight) = (outputHeight, outputWidth);
        }
        return (new JsonObject { ["width"] = outputWidth, ["height"] = outputHeight }, output);

        int Percentile(double fraction)
        {
            var count = 0;
            for (var i = 0; i < histogram.Length; i++)
            {
                count += histogram[i];
                if (count >= gray.Length * fraction) return i;
            }
            return 255;
        }
    }

    internal static byte[] CompositePng(JsonObject options, byte[] data)
    {
        var width = (int)options["width"]!;
        var height = (int)options["height"]!;
        var length = checked(width * height * 4);
        Dimensions(options, length);
        if (data.Length < (long)length * 2) throw new InvalidDataException("Missing image layers.");
        NativeProgress.Emit(5, "Ghép ảnh gốc");
        var output = data.AsSpan(0, length).ToArray();
        var offset = length * 2;
        foreach (var patch in options["patches"]?.AsArray() ?? [])
        {
            var w = (int)patch!["width"]!;
            var h = (int)patch["height"]!;
            var left = (int)patch["left"]!;
            var top = (int)patch["top"]!;
            if (w <= 0 || h <= 0 || left < 0 || top < 0 || (long)left + w > width || (long)top + h > height ||
                (long)offset + (long)w * h * 4 > data.Length) throw new InvalidDataException("Invalid export patch.");
            for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++) Blend(output, ((top + y) * width + left + x) * 4, data, offset + (y * w + x) * 4);
            offset += w * h * 4;
        }
        if (offset != data.Length) throw new InvalidDataException("Unexpected export payload.");
        NativeProgress.Emit(45, "Ghép chữ");
        for (var index = 0; index < length; index += 4) Blend(output, index, data, length + index);
        NativeProgress.Emit(75, "Mã hóa PNG");
        return Png(output, width, height);
    }

    private static void Blend(byte[] target, int at, byte[] source, int from)
    {
        var alpha = source[from + 3] / 255d;
        var oldAlpha = target[at + 3] / 255d;
        var resultAlpha = alpha + oldAlpha * (1 - alpha);
        for (var channel = 0; channel < 3; channel++)
            target[at + channel] = resultAlpha == 0 ? (byte)0 : (byte)Math.Round((source[from + channel] * alpha + target[at + channel] * oldAlpha * (1 - alpha)) / resultAlpha);
        target[at + 3] = (byte)Math.Round(resultAlpha * 255);
    }

    internal static byte[] Png(byte[] rgba, int width, int height)
    {
        using var output = new MemoryStream();
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8;
        header[9] = 6;
        Chunk("IHDR", header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, true))
        {
            for (var y = 0; y < height; y++)
            {
                zlib.WriteByte(0);
                zlib.Write(rgba, y * width * 4, width * 4);
            }
        }
        Chunk("IDAT", compressed.ToArray());
        Chunk("IEND", []);
        return output.ToArray();

        void Chunk(string type, byte[] bytes)
        {
            var tag = Encoding.ASCII.GetBytes(type);
            Span<byte> size = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(size, bytes.Length);
            output.Write(size);
            output.Write(tag);
            output.Write(bytes);
            var crc = 0xffffffffu;
            foreach (var part in new[] { tag, bytes })
            foreach (var value in part)
            {
                crc ^= value;
                for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0u : 0xedb88320u);
            }
            BinaryPrimitives.WriteUInt32BigEndian(size, ~crc);
            output.Write(size);
        }
    }
}
