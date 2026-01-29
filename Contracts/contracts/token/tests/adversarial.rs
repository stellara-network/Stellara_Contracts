#[test]
#[should_panic(expected = "Overflow")]
fn mint_overflow_attack() {
    let env = Env::default();
    let admin = Address::random(&env);

    TokenContract::initialize(env.clone(), admin.clone());

    TokenContract::mint(
        env,
        admin,
        i128::MAX
    );
}
