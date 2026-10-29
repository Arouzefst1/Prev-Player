//! Sender side of a share.
//!
//! Nothing is uploaded and nothing is copied. A tiny HTTP server streams the
//! bytes straight off the sender's disk, and the share link carries everything
//! the receiver needs to reach it. Stop the share (or quit the app) and the
//! link is dead — that is the whole "PrevPlayer never becomes a storage
//! provider" principle, implemented.
//!
//! ```text
//!   GET /s/<id>          single file, honours Range
//!   GET /f/<id>          folder manifest (JSON)
//!   GET /f/<id>/<n>      file n of a folder share, honours Range
//!   GET /h/<id>[/<n>]    whole-file SHA-256, computed lazily on first ask
//!   GET /health          liveness probe
//! ```

pub mod hashing;
mod server;

pub use hashing::{HashState, LazyHash};
pub use server::{ActiveShare, ShareServer};

pub use prev_core::content_type;
use prev_core::{EngineError, Result};
use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// Most addresses a link carries. Each is a few bytes, but the receiver dials
/// every one at once, and no real machine has a useful ninth.
const MAX_ADDRESSES: usize = 8;

/// The address the routing table would use to reach the internet.
///
/// Connecting a UDP socket sends no packets; it just asks the routing table
/// which interface would be used. On its own this was the only address a link
/// carried — see [`local_ips`] for why that wasn't enough.
pub fn routed_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Every address another device on the network might reach this one at, best
/// first.
///
/// The sender can't know which of its networks the receiver is on, and the
/// address the routing table picks for the internet is often the wrong one: a
/// VPN or a virtual adapter (WSL, Hyper-V, VirtualBox, Docker) can own the
/// default route, a PC can be on Ethernet and Wi-Fi at once with the receiver on
/// the other one, and a network with no internet has no route to ask about at
/// all. So a link lists every candidate and the receiver dials whichever answers.
pub fn local_ips() -> Vec<String> {
    let interfaces = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.oper_status != if_addrs::IfOperStatus::Down)
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some((i.name, ip)),
            IpAddr::V6(_) => None, // the share server binds IPv4 only
        })
        .collect::<Vec<_>>();
    rank_addresses(&interfaces, routed_ip())
        .into_iter()
        .map(|ip| ip.to_string())
        .collect()
}

pub fn require_local_ips() -> Result<Vec<String>> {
    let ips = local_ips();
    if ips.is_empty() {
        return Err(EngineError::Other(
            "This PC has no network address to share from — connect to Wi-Fi or Ethernet first.".into(),
        ));
    }
    Ok(ips)
}

/// Order `(interface name, address)` pairs by how likely another device is to
/// reach them: private addresses on real adapters (the routed one first), then
/// anything on a virtual or VPN adapter, then link-local. Loopback and the like
/// are dropped.
fn rank_addresses(interfaces: &[(String, Ipv4Addr)], routed: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let tier = |name: &str, ip: Ipv4Addr| -> Option<u8> {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
            return None;
        }
        if ip.is_link_local() {
            return Some(3); // 169.254.x — only when there's no DHCP at all
        }
        if ip.is_private() && !looks_virtual(name) {
            return Some(if Some(ip) == routed { 0 } else { 1 });
        }
        Some(2)
    };
    let mut ranked: Vec<(u8, usize, Ipv4Addr)> = interfaces
        .iter()
        .enumerate()
        .filter_map(|(i, (name, ip))| tier(name, *ip).map(|t| (t, i, *ip)))
        .collect();
    ranked.sort();
    let mut out = Vec::new();
    for (_, _, ip) in ranked {
        if !out.contains(&ip) && out.len() < MAX_ADDRESSES {
            out.push(ip);
        }
    }
    out
}

/// Adapters that exist on this machine but rarely face the receiver's network.
fn looks_virtual(name: &str) -> bool {
    const HINTS: &[&str] = &[
        "vethernet", "hyper-v", "wsl", "virtualbox", "vbox", "vmware", "vmnet", "docker",
        "veth", "virbr", "br-", "loopback", "pseudo", "vpn", "tap", "tun", "wireguard", "wg",
        "tailscale", "zerotier", "npcap", "bluetooth",
        // VPN clients whose adapters don't say "VPN"
        "nordlynx", "mullvad", "warp", "anyconnect", "pangp", "fortinet", "hamachi", "radmin",
    ];
    let name = name.to_ascii_lowercase();
    HINTS.iter().any(|h| name.contains(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn real_adapters_come_before_vpns_and_virtual_switches() {
        let ifaces = vec![
            ("vEthernet (WSL)".to_string(), ip("172.28.80.1")),
            ("NordLynx".to_string(), ip("10.5.0.2")),
            ("Wi-Fi".to_string(), ip("192.168.1.23")),
            ("Loopback Pseudo-Interface 1".to_string(), ip("127.0.0.1")),
            ("Ethernet".to_string(), ip("10.0.0.7")),
        ];
        // The VPN owns the default route, which is exactly the case that broke.
        let got = rank_addresses(&ifaces, Some(ip("10.5.0.2")));
        assert_eq!(got[..2], [ip("192.168.1.23"), ip("10.0.0.7")], "real adapters first: {got:?}");
        assert!(got.contains(&ip("172.28.80.1")) && got.contains(&ip("10.5.0.2")), "still offered: {got:?}");
        assert!(!got.contains(&ip("127.0.0.1")));
    }

    #[test]
    fn the_routed_address_leads_when_it_is_a_real_lan_address() {
        let ifaces = vec![
            ("Ethernet".to_string(), ip("10.0.0.7")),
            ("Wi-Fi".to_string(), ip("192.168.1.23")),
        ];
        assert_eq!(rank_addresses(&ifaces, Some(ip("192.168.1.23")))[0], ip("192.168.1.23"));
    }

    #[test]
    fn a_network_without_internet_still_yields_its_address() {
        let ifaces = vec![("Wi-Fi".to_string(), ip("192.168.137.4"))];
        assert_eq!(rank_addresses(&ifaces, None), [ip("192.168.137.4")]);
    }

    #[test]
    fn link_local_goes_last_and_duplicates_once() {
        let ifaces = vec![
            ("Ethernet 2".to_string(), ip("169.254.10.2")),
            ("Wi-Fi".to_string(), ip("192.168.1.23")),
            ("Wi-Fi".to_string(), ip("192.168.1.23")),
        ];
        assert_eq!(rank_addresses(&ifaces, None), [ip("192.168.1.23"), ip("169.254.10.2")]);
    }
}
