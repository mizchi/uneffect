use std::io::{self, Read};
use uneffect_core::corsa::consume_corsa_json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let normalized = consume_corsa_json(&input)?.normalized();
    println!("{}", serde_json::to_string(&normalized)?);
    Ok(())
}
