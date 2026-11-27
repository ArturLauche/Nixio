using System.IO.Compression;
using System.Text.Json.Nodes;

internal sealed class ProjectStorage : IDisposable
{
    private const int MaximumPages = 50;
    private static readonly byte[] PngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

    private sealed record Transfer(string Path, string Temporary, FileStream Stream, bool Backup, ZipArchive? Zip)
    {
        internal int Pages { get; set; }
        internal string? Damage { get; set; }
    }

    private readonly Dictionary<string, Transfer> transfers = [];
    private readonly Dictionary<string, FileStream> readers = [];

    internal (JsonObject, byte[]) Execute(string operation, JsonObject options, byte[] data)
    {
        switch (operation)
        {
            case "fileBegin":
            case "zipBegin":
            {
                var path = Path.GetFullPath((string)options["path"]!);
                if (Path.GetDirectoryName(path) is { Length: > 0 } directory)
                    Directory.CreateDirectory(directory);
                var temporary = path + "." + Guid.NewGuid() + ".tmp";
                var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write);
                var id = Guid.NewGuid().ToString();
                var zip = operation == "zipBegin" ? new ZipArchive(stream, ZipArchiveMode.Create, true) : null;
                transfers.Add(id, new Transfer(path, temporary, stream, (bool?)options["backup"] ?? false, zip));
                return (new JsonObject { ["id"] = id }, []);
            }
            case "fileOpen":
            {
                var stream = new FileStream((string)options["path"]!, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var id = Guid.NewGuid().ToString();
                readers.Add(id, stream);
                return (new JsonObject { ["id"] = id, ["size"] = stream.Length }, []);
            }
            case "fileReadNext":
            {
                if (!readers.TryGetValue((string)options["id"]!, out var stream)) throw new InvalidDataException("Unknown reader.");
                var bytes = new byte[(int)Math.Min(4 * 1024 * 1024, stream.Length - stream.Position)];
                stream.ReadExactly(bytes);
                return (new JsonObject { ["size"] = stream.Length }, bytes);
            }
            case "fileClose":
            {
                if (readers.Remove((string)options["id"]!, out var stream)) stream.Dispose();
                return (new JsonObject(), []);
            }
            case "fileRead":
            {
                using var stream = File.OpenRead((string)options["path"]!);
                var offset = (long?)options["offset"] ?? 0;
                if (offset < 0 || offset > stream.Length) throw new InvalidDataException("Invalid project size or offset.");
                stream.Position = offset;
                var bytes = new byte[(int)Math.Min(4 * 1024 * 1024, stream.Length - offset)];
                stream.ReadExactly(bytes);
                return (new JsonObject { ["size"] = stream.Length }, bytes);
            }
            case "fileAppend":
            {
                var item = Get(options);
                if (item.Zip != null) throw new InvalidDataException("Invalid project transfer.");
                if (item.Damage is { } damage) throw new InvalidDataException(damage);
                try { item.Stream.Write(data); }
                catch (Exception error)
                {
                    item.Damage = "The temporary file is incomplete.";
                    throw new InvalidDataException("Could not write the project file.", error);
                }
                return (new JsonObject(), []);
            }
            case "zipAppend":
            case "zipPage":
            {
                var item = Get(options);
                if (item.Zip == null) throw new InvalidDataException("Expected a ZIP transfer.");
                if (item.Damage is { } damage) throw new InvalidDataException(damage);
                var name = (string)options["name"]!;
                if (name != Path.GetFileName(name) || name.Contains('\\') || !name.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Invalid ZIP page name.");
                if (item.Pages >= MaximumPages) throw new InvalidDataException("Invalid ZIP page count.");
                // Compose and validate the page before the archive or the page count changes, so a
                // rejected page leaves no empty entry and never consumes the page limit.
                var png = operation == "zipPage" ? NativeImaging.CompositePng(options, data) : data;
                if (png.Length < PngSignature.Length || !png.AsSpan(0, PngSignature.Length).SequenceEqual(PngSignature))
                    throw new InvalidDataException("Invalid PNG page.");
                try
                {
                    using var entry = item.Zip.CreateEntry(name, CompressionLevel.NoCompression).Open();
                    entry.Write(png);
                }
                catch (Exception error)
                {
                    item.Damage = "The temporary archive is incomplete.";
                    throw new InvalidDataException("Could not write the ZIP page.", error);
                }
                item.Pages++;
                return (new JsonObject(), []);
            }
            case "fileCommit":
            {
                var id = (string)options["id"]!;
                if (!transfers.Remove(id, out var item)) throw new InvalidDataException("Unknown transfer.");
                return (Commit(item), []);
            }
            case "fileCancel":
            {
                var id = (string)options["id"]!;
                if (transfers.Remove(id, out var item)) Delete(item);
                return (new JsonObject(), []);
            }
            default: throw new InvalidDataException("Unknown native operation: " + operation);
        }
    }

    // The primary is published only after the temporary file is complete and a ZIP transfer
    // reads back. The backup copy of the current primary is staged beside the temporary file,
    // then published after the primary. A failure before the primary publish leaves the
    // destination and its backup untouched; a failed backup publish keeps the older backup.
    private static JsonObject Commit(Transfer item)
    {
        var staged = item.Temporary + ".bak";
        try
        {
            if (item.Damage is { } damage) throw new InvalidDataException(damage);
            Seal(item);
            if (item.Zip != null) VerifyArchive(item);
            var backup = false;
            if (item.Backup && File.Exists(item.Path))
            {
                try
                {
                    File.Copy(item.Path, staged);
                    using var copy = new FileStream(staged, FileMode.Open, FileAccess.ReadWrite);
                    copy.Flush(true);
                }
                catch (Exception error)
                {
                    throw new InvalidDataException("Could not prepare the backup copy.", error);
                }
                backup = true;
            }
            try { ReplaceCommittedFile(item.Temporary, item.Path); }
            catch (Exception error) { throw new InvalidDataException("Could not replace the destination file.", error); }
            if (!backup) return new JsonObject { ["backup"] = "none" };
            try
            {
                ReplaceCommittedFile(staged, item.Path + ".bak");
                return new JsonObject { ["backup"] = "written" };
            }
            catch (Exception)
            {
                // The new primary is already published. Keep the older backup instead of
                // deleting data, and report that the backup is older than the primary.
                return new JsonObject { ["backup"] = "kept" };
            }
        }
        finally
        {
            Delete(item);
            Discard(staged);
        }
    }

    private static void Seal(Transfer item)
    {
        try
        {
            item.Zip?.Dispose();
            item.Stream.Flush(true);
        }
        catch (Exception error)
        {
            throw new InvalidDataException("Could not finish the temporary file.", error);
        }
    }

    private static void VerifyArchive(Transfer item)
    {
        int entries;
        try
        {
            using var archive = ZipFile.OpenRead(item.Temporary);
            entries = archive.Entries.Count;
        }
        catch (Exception error) when (error is InvalidDataException or IOException)
        {
            throw new InvalidDataException("The temporary archive is incomplete.", error);
        }
        if (entries != item.Pages) throw new InvalidDataException("The temporary archive is incomplete.");
    }

    private static void ReplaceCommittedFile(string source, string destination)
    {
        // ReplaceFile preserves open readers on Windows. MoveFileEx overwrite can deny access
        // even when those readers explicitly share deletion.
        if (OperatingSystem.IsWindows() && File.Exists(destination))
            File.Replace(source, destination, null);
        else
            File.Move(source, destination, true);
    }

    private Transfer Get(JsonObject options) => transfers.TryGetValue((string)options["id"]!, out var item)
        ? item : throw new InvalidDataException("Unknown transfer.");

    // Cleanup never fails a request: the temporary file is our own uniquely named copy and the
    // destination is not touched here.
    private static void Delete(Transfer item)
    {
        try { item.Zip?.Dispose(); } catch (Exception) { }
        try { item.Stream.Dispose(); } catch (Exception) { }
        Discard(item.Temporary);
    }

    private static void Discard(string path)
    {
        try { File.Delete(path); } catch (Exception) { }
    }

    public void Dispose()
    {
        foreach (var item in transfers.Values) Delete(item);
        transfers.Clear();
        foreach (var reader in readers.Values) reader.Dispose();
        readers.Clear();
    }
}
