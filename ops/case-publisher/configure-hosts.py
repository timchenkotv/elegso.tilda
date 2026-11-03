"""Install the narrow site-to-law TLS edge resolver mapping without replacing hosts."""
import argparse
import ipaddress
from pathlib import Path

START = "# BEGIN ELEGSO CASE PUBLISHER"
END = "# END ELEGSO CASE PUBLISHER"


def configured_hosts(original: str, mapping: str) -> str:
    entries = [line.split("#", 1)[0].split() for line in mapping.splitlines() if line.split("#", 1)[0].strip()]
    if len(entries) != 1 or len(entries[0]) != 2 or entries[0][1] != "law.elegso.ru":
        raise ValueError("Only one explicit law.elegso.ru edge mapping is permitted")
    address, host = entries[0]
    if not ipaddress.ip_address(address).is_private:
        raise ValueError("Expected a private internal TLS edge address")
    if START in original or END in original:
        if original.count(START) != 1 or original.count(END) != 1 or original.index(START) > original.index(END):
            raise ValueError("Invalid managed hosts block")
        start, tail = original.split(START)
        _, tail = tail.split(END)
        original = start + tail.lstrip("\n")
    for line in original.splitlines():
        fields = line.split("#", 1)[0].split()
        if host in fields[1:]:
            if fields[0] != address:
                raise ValueError("Conflicting unmanaged law.elegso.ru mapping; review before deploying")
            return original
    return original.rstrip("\n") + f"\n\n{START}\n{address} {host}\n{END}\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hosts", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    args = parser.parse_args()
    current = args.hosts.read_text()
    updated = configured_hosts(current, args.mapping.read_text())
    if updated != current:
        args.hosts.write_text(updated)


if __name__ == "__main__":
    main()
