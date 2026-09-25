import type { ReadStream, WriteStream } from "node:tty";

export function supportsInteractiveTui(stdin: Pick<ReadStream, "isTTY"> = process.stdin, stdout: Pick<WriteStream, "isTTY"> = process.stdout): boolean {
    return Boolean(stdin.isTTY && stdout.isTTY);
}
