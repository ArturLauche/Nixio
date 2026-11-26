using System.Buffers.Binary;

using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
var header = new byte[6 * sizeof(int)];
var size = new byte[sizeof(int)];

while (input.ReadByte() is var first && first != -1)
{
    header[0] = (byte)first;
    input.ReadExactly(header.AsSpan(1));
    var width = ReadField(0);
    var height = ReadField(1);
    var area = new Region(ReadField(2), ReadField(3), ReadField(4), ReadField(5));
    if (width <= 0 || height <= 0 || (long)width * height > 1_600_000 ||
        area.Left < 0 || area.Top < 0 || area.Right > width || area.Bottom > height ||
        area.Width < 2 || area.Height < 2)
        return 1;

    var pixels = GC.AllocateUninitializedArray<byte>(width * height * 4);
    input.ReadExactly(pixels);
    var result = TextureRedraw.Recover(pixels, width, height, area);
    BinaryPrimitives.WriteInt32LittleEndian(size, result?.Length ?? 0);
    output.Write(size);
    if (result is not null)
        output.Write(result);
    output.Flush();
}

return 0;

int ReadField(int index) => BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(index * sizeof(int)));

internal readonly record struct Region(int Left, int Top, int Right, int Bottom)
{
    internal int Width => Right - Left;
    internal int Height => Bottom - Top;
}
