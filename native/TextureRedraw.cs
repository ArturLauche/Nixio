using System.Numerics;

internal static partial class RedrawEngine
{
    private const int TargetSamples = 12_000;
    private const int MaximumPeriod = 16;
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

        return changed == 0 || changed > area.Width * area.Height * .48 ? null : patch;
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

    private static double Luma(double red, double green, double blue) => (red * 54 + green * 183 + blue * 19) / 256d;
}
