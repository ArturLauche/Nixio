using System.Numerics;

internal static partial class RedrawEngine
{
    private const int TargetSamples = 12_000;
    private const int MaximumPeriod = 32;
    private const int MinimumPhaseSamples = 4;

    private readonly record struct Sample(int X, int Y, byte Red, byte Green, byte Blue, double Luma);
    private readonly record struct Texture(int Period, Vector3[] Colors, PaperPlane? Trend);

    private struct Phase
    {
        internal int Count;
        internal Vector3 Color;
        internal double Sum;
        internal double Squares;

        internal void Add(Sample point, Vector3 correction)
        {
            Count++;
            Color += new Vector3(point.Red, point.Green, point.Blue) - correction;
            var luma = point.Luma - Luma(correction.X, correction.Y, correction.Z);
            Sum += luma;
            Squares += luma * luma;
        }

        internal readonly Vector3 Mean() => Color / Count;
    }

    internal static byte[]? Recover(byte[] pixels, int width, int height, Region area)
    {
        var samples = CollectSamples(pixels, width, height, area);
        if (samples.Count < 32)
            return null;
        var background = FindTexture(samples);
        if (background is null && ApproximatePaper(samples) is { } trend)
            background = FindTexture(samples, trend);
        if (background is not { } texture)
            return RecoverGradient(pixels, width, height, area, samples);

        var patch = new byte[area.Width * area.Height * 4];
        var changed = 0;
        for (var y = area.Top; y < area.Bottom; y++)
        {
            var row = y % texture.Period * texture.Period;
            for (var x = area.Left; x < area.Right; x++)
            {
                var index = (y * width + x) * 4;
                var expected = texture.Colors[row + x % texture.Period];
                if (texture.Trend is { } slope)
                    expected += slope.DeltaAt(x, y);
                expected = Vector3.Clamp(expected, Vector3.Zero, new Vector3(255));
                if (pixels[index + 3] < 240 || Luma(expected.X, expected.Y, expected.Z) - Luma(pixels[index], pixels[index + 1], pixels[index + 2]) < 32)
                    continue;

                var destination = ((y - area.Top) * area.Width + x - area.Left) * 4;
                patch[destination] = (byte)MathF.Round(expected.X);
                patch[destination + 1] = (byte)MathF.Round(expected.Y);
                patch[destination + 2] = (byte)MathF.Round(expected.Z);
                patch[destination + 3] = 255;
                changed++;
            }
        }

        if (changed == 0 || changed > area.Width * area.Height * .48) return null;
        ProtectTextureEdges(pixels, width, height, area, texture, patch);
        return patch.Any(value => value != 0) ? patch : null;
    }

    private static List<Sample> CollectSamples(byte[] pixels, int width, int height, Region area)
    {
        var ringPixels = width * height - area.Width * area.Height;
        var stride = Math.Max(1, (ringPixels + TargetSamples - 1) / TargetSamples);
        var samples = new List<Sample>(Math.Min(ringPixels, TargetSamples));
        for (var y = 0; y < height; y++)
        {
            if (y >= area.Top && y < area.Bottom)
            {
                ReadRange(0, area.Left, y);
                ReadRange(area.Right, width, y);
            }
            else
            {
                ReadRange(0, width, y);
            }
        }
        return samples;

        void ReadRange(int start, int end, int y)
        {
            // Vary sampling by row so a stride cannot select only one phase of the pattern.
            uint seed = unchecked((uint)y * 2654435761u + (uint)start * 2246822519u);
            var offset = (int)((seed ^ (seed >> 16)) % (uint)stride);
            for (var x = start + offset; x < end; x += stride)
            {
                var index = (y * width + x) * 4;
                if (pixels[index + 3] < 240)
                    continue;
                var red = pixels[index];
                var green = pixels[index + 1];
                var blue = pixels[index + 2];
                samples.Add(new Sample(x, y, red, green, blue, Luma(red, green, blue)));
            }
        }
    }

    private static Texture? FindTexture(List<Sample> samples, PaperPlane? trend = null)
    {
        // Removing the shared color slope lets the same phase test recognize shaded screentones.
        var corrections = trend is { } plane
            ? samples.Select(sample => plane.DeltaAt(sample.X, sample.Y)).ToArray()
            : null;
        var sum = 0d;
        var squares = 0d;
        for (var i = 0; i < samples.Count; i++)
        {
            var correction = corrections is null ? Vector3.Zero : corrections[i];
            var luma = samples[i].Luma - Luma(correction.X, correction.Y, correction.Z);
            sum += luma;
            squares += luma * luma;
        }
        var flatVariance = squares / samples.Count - Math.Pow(sum / samples.Count, 2);
        if (flatVariance < 144)
            return null;

        var bestScore = double.PositiveInfinity;
        Texture? best = null;
        for (var period = 2; period <= MaximumPeriod; period++)
        {
            var phases = new Phase[period * period];
            for (var i = 0; i < samples.Count; i++)
            {
                var sample = samples[i];
                phases[sample.Y % period * period + sample.X % period].Add(sample, corrections is null ? Vector3.Zero : corrections[i]);
            }
            if (phases.Any(phase => phase.Count < MinimumPhaseSamples))
                continue;

            // Refit phases after excluding sparse ink crossing the sample ring.
            var robust = new Phase[phases.Length];
            var accepted = 0;
            for (var i = 0; i < samples.Count; i++)
            {
                var sample = samples[i];
                var phase = sample.Y % period * period + sample.X % period;
                var correction = corrections is null ? Vector3.Zero : corrections[i];
                var prediction = phases[phase].Mean() + correction;
                if (Math.Abs(sample.Luma - Luma(prediction.X, prediction.Y, prediction.Z)) > 24) continue;
                robust[phase].Add(sample, correction);
                accepted++;
            }
            if (accepted >= samples.Count * .9 && robust.All(phase => phase.Count >= MinimumPhaseSamples))
                phases = robust;

            var error = 0d;
            var minimum = 255d;
            var maximum = 0d;
            foreach (var phase in phases)
            {
                var mean = phase.Sum / phase.Count;
                minimum = Math.Min(minimum, mean);
                maximum = Math.Max(maximum, mean);
                error += phase.Squares - phase.Sum * mean;
            }

            var variance = error / samples.Count;
            var score = variance + period * .3;
            // A repeatable pattern must predict the outer ring much better than a flat color.
            if (maximum - minimum < 30 || variance > Math.Min(81, flatVariance * .12) || score >= bestScore)
                continue;

            bestScore = score;
            best = new Texture(period, Array.ConvertAll(phases, phase => phase.Mean()), trend);
        }
        return best;
    }

    private static void ProtectTextureEdges(byte[] pixels, int width, int height, Region area, Texture texture, byte[] patch)
    {
        var visited = new bool[area.Width * area.Height];
        var queue = new Queue<int>();
        for (var y = 0; y < area.Height; y++)
        for (var x = 0; x < area.Width; x++)
        {
            if (x != 0 && y != 0 && x != area.Width - 1 && y != area.Height - 1) continue;
            var at = y * area.Width + x;
            if (patch[at * 4 + 3] == 0) continue;
            for (var dy = -1; dy <= 1; dy++)
            for (var dx = -1; dx <= 1; dx++)
            {
                var nx = x + dx;
                var ny = y + dy;
                if ((uint)nx < area.Width && (uint)ny < area.Height) continue;
                if (IsInk(area.Left + nx, area.Top + ny) && !visited[at])
                {
                    visited[at] = true;
                    queue.Enqueue(at);
                }
            }
        }
        while (queue.TryDequeue(out var at))
        {
            patch[at * 4 + 3] = 0;
            for (var dy = -1; dy <= 1; dy++)
            for (var dx = -1; dx <= 1; dx++)
            {
                var x = at % area.Width + dx;
                var y = at / area.Width + dy;
                if ((uint)x >= area.Width || (uint)y >= area.Height) continue;
                var next = y * area.Width + x;
                if (visited[next] || patch[next * 4 + 3] == 0) continue;
                visited[next] = true;
                queue.Enqueue(next);
            }
        }

        bool IsInk(int x, int y)
        {
            if ((uint)x >= width || (uint)y >= height) return false;
            var at = (y * width + x) * 4;
            var predicted = texture.Colors[y % texture.Period * texture.Period + x % texture.Period];
            if (texture.Trend is { } trend) predicted += trend.DeltaAt(x, y);
            return pixels[at + 3] >= 240 && Luma(predicted.X, predicted.Y, predicted.Z) -
                Luma(pixels[at], pixels[at + 1], pixels[at + 2]) >= 32;
        }
    }

    private static double Luma(double red, double green, double blue) => (red * 54 + green * 183 + blue * 19) / 256d;
}
