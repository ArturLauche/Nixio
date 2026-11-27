using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;

internal static class NativeRpc
{
    internal const int MaximumData = 512 * 1024 * 1024;
    // The renderer declares the same range in `src/native.js` and the Electron client compares it in
    // `desktop/native-worker.cjs`. Change both ends together and only for an incompatible framing
    // change: every reply carries the full range so the other side can name both versions instead of
    // half-parsing a frame it does not understand.
    internal const int ProtocolVersion = 1;
    internal const int ProtocolMinimum = 1;
    internal static readonly string[] Operations =
        ["redraw", "mask", "inpaint", "content_aware_cleanup", "seamless_clone", "clean_raw", "preprocess", "ocr", "png", "zip", "project"];

    internal static JsonObject OperationVersions()
    {
        var versions = new JsonObject();
        foreach (var operation in Operations) versions[operation] = ProtocolVersion;
        return versions;
    }

    internal static async Task<int> Run()
    {
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        using var storage = new ProjectStorage();
        var header = new byte[12];
        while (input.ReadByte() is var first && first != -1)
        {
            header[0] = (byte)first;
            input.ReadExactly(header.AsSpan(1));
            var metaLength = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4));
            var dataLength = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(8));
            if (Encoding.ASCII.GetString(header, 0, 4) != "KTR1" ||
                metaLength < 2 || metaLength > 4 * 1024 * 1024 || dataLength < 0 || dataLength > MaximumData) return 1;
            var metadata = new byte[metaLength];
            var data = new byte[dataLength];
            input.ReadExactly(metadata);
            input.ReadExactly(data);
            JsonObject reply;
            byte[] bytes = [];
            try
            {
                var request = JsonNode.Parse(metadata)!.AsObject();
                // The request states the range the app accepts. A worker that cannot serve it answers
                // with its own range instead of failing an operation mid-stream, so the other side can
                // keep this process alive for the project handles it owns.
                var protocol = request["protocol"]?.AsObject();
                var clientMinimum = ProtocolMinimum;
                var clientMaximum = ProtocolVersion;
                if (protocol?["min"] is JsonValue minimum && minimum.TryGetValue<int>(out var declaredMinimum)) clientMinimum = declaredMinimum;
                if (protocol?["max"] is JsonValue maximum && maximum.TryGetValue<int>(out var declaredMaximum)) clientMaximum = declaredMaximum;
                var declaredVersion = request["version"]?.GetValue<int>() ?? ProtocolVersion;
                if (declaredVersion < ProtocolMinimum || declaredVersion > ProtocolVersion ||
                    clientMinimum > ProtocolVersion || clientMaximum < ProtocolMinimum)
                    throw new InvalidDataException(
                        $"Native protocol incompatible: worker supports {ProtocolMinimum}-{ProtocolVersion}, app supports {clientMinimum}-{clientMaximum}.");
                var options = request["options"]?.AsObject() ?? new JsonObject();
                var operation = request["operation"]!.GetValue<string>();
                NativeProgress.Report = (progress, stage) => Write(new JsonObject {
                    ["version"] = ProtocolVersion, ["event"] = "progress", ["progress"] = progress, ["stage"] = stage,
                }, []);
                (reply, bytes) = operation switch
                {
                    "capabilities" => (await LocalOcr.Capabilities(), []),
                    "redraw" => Redraw(options, data),
                    "mask" => (new JsonObject(), NativeImaging.Mask(options, data)),
                    "inpaint" => PatchMatchInpaint.Execute(options, data),
                    "content_aware_cleanup" => PatchMatchInpaint.ExecuteContentAware(options, data),
                    "seamless_clone" => PoissonBlend.ExecuteSeamlessClone(options, data),
                    "clean_raw" => RawCleanup.Execute(options, data),
                    "preprocess" => NativeImaging.Preprocess(options, data),
                    "ocr" => (await LocalOcr.Recognize(options, data), []),
                    "png" => (new JsonObject(), NativeImaging.CompositePng(options, data)),
                    _ => storage.Execute(operation, options, data),
                };
                reply["ok"] = true;
            }
            catch (Exception error)
            {
                reply = new JsonObject { ["ok"] = false, ["error"] = error.Message };
            }
            NativeProgress.Report = null;
            reply["version"] = ProtocolVersion;
            reply["protocolVersion"] = ProtocolVersion;
            reply["minProtocol"] = ProtocolMinimum;
            reply["maxProtocol"] = ProtocolVersion;
            Write(reply, bytes);
        }
        return 0;

        void Write(JsonObject reply, byte[] bytes)
        {
            var metadata = Encoding.UTF8.GetBytes(reply.ToJsonString());
            Span<byte> responseHeader = stackalloc byte[12];
            "KTR1"u8.CopyTo(responseHeader);
            BinaryPrimitives.WriteInt32LittleEndian(responseHeader[4..], metadata.Length);
            BinaryPrimitives.WriteInt32LittleEndian(responseHeader[8..], bytes.Length);
            output.Write(responseHeader);
            output.Write(metadata);
            output.Write(bytes);
            output.Flush();
        }
    }

    private static (JsonObject, byte[]) Redraw(JsonObject options, byte[] data)
    {
        var (width, height) = NativeImaging.Dimensions(options, data.Length, 1_600_000);
        var region = options["inner"]!;
        var area = new Region((int)region["left"]!, (int)region["top"]!, (int)region["right"]!, (int)region["bottom"]!);
        if (area.Left < 0 || area.Top < 0 || area.Right > width || area.Bottom > height || area.Width < 2 || area.Height < 2)
            throw new InvalidDataException("Invalid redraw region.");
        return (new JsonObject(), RedrawEngine.Recover(data, width, height, area) ?? []);
    }
}
