import { describe, expect, it } from 'vitest'
import { srpBase64, srpProof, srpPublic } from './icloud-apple-srp'

/*
 * Reference vectors from an independent implementation (Python big ints and
 * hashlib, generated for this test). The edge cases put a leading zero byte in
 * A, B or the shared secret S, where padding instead of minimal encoding would
 * change the proof: the generator checked that each one does.
 */
const VECTORS = [
  {
    name: 's2k',
    appleId: 'owner@icloud.com',
    password: 'correct horse battery staple',
    protocol: 's2k',
    iteration: 1000,
    salt: 'WTupzQq71P5BVGZTW0Cg8g==',
    secret: '2c2a64c37400c990834b53709ac82b31584a4c1bc117ad0f154451e1dce2644b',
    a: 'gQ01lZlm/78AGu4E+Gxn6+g5NOZ8Wt1FTHy0EP1iLHCcROMFRwnz/PU5lemuvg0FyIyHI7+Vdqth0gZbH5En4lOicfqbgasX'
      + 'dyoFolzBw17FVe3sldWivL/C5Z9/BzRyxPkCKR1TR8MXFwDe2jSWGOqP+W6HYZHgFMyTfHJNVAfDOQu0uXmL8uqws+7Qno2c'
      + '0u80upr5bmv8Ntr7m5WI7FWGY9WtRcM9sAXVg4Co669nn3daHQN2fOd6F1b2o0IfeiM8ocpk4k/O3dNU+ZqJWX2I8trURvWS'
      + 'DT01u1m1tnizcB4RrdXz7LVOKEESbtNr2c0EwVhIRcNdd9lJdKJIcA==',
    b: 'Q+yBX99/G9FHP9y0z6hRdlwkM4JgJb8ef2t0wVIDOJAP7tbnZZqKVQWnqF4gmshJ1y57+SCNbtfi5NHO77wScUngqDDBzw2m'
      + '4KXMQG0HNhMk16jyR42kInVwy4cCec+ZJ6ZvfjYjh38REFN23rmZDVq35Q7U2AWZhcx6DsgUqdyql6H3mlzhB+tpX7diPd0l'
      + 'BigeEC0BCFqcdXMG/lr3IpXX32j1UEauYAC6QPNy5KuMD5E+IJjuzkPA6U4dTOgiB6tzH9KJuEH+2tdly29ZXJ8B+pGG/TLg'
      + '1ah2NlUdg/ZIp6fU7n6sNaIXIRDoycsaZVMx0s4jZ7+/mgRe1C7rIg==',
    m1: '8K1wjm9PaCaao5XmtnrF0h29OFEWhaEbrrOTp5ygCfs=',
    m2: 'jjzpI29nnKC982eKhLycZcmq7yF2zdmtnvbfAVK61lI=',
  },
  {
    name: 's2k_fo',
    appleId: 'owner@icloud.com',
    password: 'correct horse battery staple',
    protocol: 's2k_fo',
    iteration: 1000,
    salt: 'aoU1rInlZ24ZUAJ8fIq63Q==',
    secret: '472906a4b887146927c88a6cbb7d91448c37962f69a54c583e13d14a44ad430d',
    a: 'C/3D8qbRglq0tZTD4TTo2RV5oMHtDem/02tMmXq6+xVLjs9MSV5CAe5BT3PmmUGUEcIdRcf89vERt5KVCFbAKA4HFMD9sWJa'
      + 'AjQKfVySsFzrdf/ME9g288RMR+pbZK1BRjvq/LLNP+XpoY0TJ3KNAQS8tNh1QcUqb45oyhEUqVvFYveaZrWKikrJk4VsAUH5'
      + 'wsTRaGplMXAORwkv4Cf83ysZViG0UY2o/B2XiDMJvh2bx1Gur1inOFDMf4INkAHNk2t9M5ufbN4oBS0JpjjXGvS4OFAU2mRG'
      + 're7ZSIbexpSQEDfob/bdc+vX733QDEwIVDZCd+ebzsQRYy/GbSBHuA==',
    b: 'QVVOuagXDggqErRvvAAuAsfFzePori3ELo9yy2EhZSEfaPBRyLy50IuC67ijkixISxjZmSwlyrUNsibCWezzBYP3pcuc4Uoq'
      + 'Z9c9oOkkvGfJysq7dOJOIfU+UWGwzIbxgA5QVJjJ31/zdH4QMWKxd0J8gKAgeNwYYzNwDFFjXAWeAbpjzzsnmsbAAYLygkhJ'
      + 'nyhC3DgLcykc5PIebqZQpB9kQPOLvS40BKDrKqEbiMuzttzdp07WYeFMrQSSYByKMZ+quEveOXushY+76kY/otOZdN5pnECz'
      + 'zuvdyDRyjzHdbUQ3KqG9UkSnQD2YSERrIdXAQKZKvrNHFPxDG/V2zA==',
    m1: 'wxObJxP5G+gs7Px0HfF3PPQf2hIb2lM0rgatLcWj8QY=',
    m2: 'wVUnJyOojcPj6jcteCwPSJM4/qzZDxev2tqIG6WEsXA=',
  },
  {
    name: 'A with a leading zero byte',
    appleId: 'owner@icloud.com',
    password: 'hunter2!',
    protocol: 's2k',
    iteration: 1000,
    salt: 'ZSHFjLckkZA/Bwn97gTneA==',
    secret: '93da587e45bd18781757ee5b9aa0cf0e8f98243ec1fbed35d56e26800f7354fe',
    a: 'zMHgXochRSwsfaGMd8fi0obCIQ6ols0lbjnilrbjhJuILXeEfws/pEN4oC7HIR7gvJOKHjEIUHJBzH3Agijw/ybmObqppbDu'
      + 'J7/pLb4rTIj7gq2W44FeS29a1nFJICVpqIj7Mrt4knjnTkfivi/cDRgpDS2288t4cVASrQL0EEK+VRIkX/bUddcCKEu9M196'
      + 'CCujjENHg3EoLHC3paYXY6ewpAwAIfxxnUg1XuVIVS9wkjh8Lyvf2HacRUCRXxz535pRWYdHjcdGFZoKKLEwJlTkSVUfdT5V'
      + 'emQMuQYBQyWf6e08WBYTbwDCvo+RY4aA43RDBjoDe0OPLC/YLrB3',
    b: 'aTiQ8yGj7fcEoQRMzQt9z8z5TV6s5Olc/pjv3Dk0KSikR5YHap6LmnPs1+dXTF/FLa/Qi3UyCH0NVl90HkhvG+yzbTi7dayf'
      + 'Rduz5P1aQTr9cqqiHq2MKUu6lPhsfJMp+toFVYNqB6I6xOvM24IQB1CJckjQ/dA4OArnXQBy77gcsj+LUIvlasHtQWnJVAtB'
      + '+676GDcCYfhN4D9+ndDoOe5VV8TFXogIE9YKgI1ibp8oG3SzrkkUe1yP7q1quXjmVaXagwW74qMKoTAqld0tVc2bWG2Igg42'
      + 'niOTL7A2AlbOzQWo5kpb0nciDVr4t3frsTtzea3nJtylarY1/d75gQ==',
    m1: 'nbHP142YvEVM9hgC3iKAu4YuHaNNl1XjICQZ9aExsYc=',
    m2: 'NwtoqnZPHy2BUjXxsr5RfKvDO+gI5HssXSE8DUEEMQM=',
  },
  {
    name: 'B with a leading zero byte',
    appleId: 'owner@icloud.com',
    password: 'hunter2!',
    protocol: 's2k',
    iteration: 1000,
    salt: 'qiB7tMGKMqWrxFNbWXePOA==',
    secret: 'a9411800e127d764fba8db747848f2a170128d4ad1b6ad627d371d8f61dc9d31',
    a: 'BRgPgPAEchSFpcsgOM/8qehAq6oRUFcg0icvE0r7tP3Z56uI/bDV3G+OnmRpMXpYR1bezCNnf25Ig7TTYyl5H6eUQRUZ/g9h'
      + 'EgVlBg4KgSYQv/2XIrpqTubckd3M0P6z4VOxEqyjoxU08HRL5s9XGMJ09CruH6mb1B5ucBnq+YrGl+bU83R+NQEgFd8exBr1'
      + '845T8gkEclDY7EDYyZaIHmEOehbRbqTQrttExGfkShfMRzJV7HA9TD0DAZkozhe75aYlJlREfdoXheFnQjX1SouWOF2SlXls'
      + 'DlIII6hy1Mg7w47eUjjrSesN78YvK9SH1ppsVYtk5kGnbCMKs2DjaQ==',
    b: 'JOaLCvFd4W+q8sqJAcZRTcmd61fZ/cdGj/n87l/fcnbCgHOsOTmQB1Qcn35FNvpzWeN2qeoOL5s/C/kUV55lIm1jowIidixz'
      + 'mhtdb/wgCBeqXch7hTb+sF2olG9YqhkS7GYpfP8kFmuj/EMFPP38V5dtvlnvbk6/NvZlVweOoN4iSDOXZtB8o9REtRP5vOvN'
      + 'SzDezfh6JZlQxyBLK2mo5mWTIrrt4xWvcv1Ov6+lXdP+jJVWZghSH5QlAusdG9Uap/MBS+/BA6UrQQcSE13z4BCFUGhvFmSN'
      + 'zHUGMhAxQ9UuvLNydlYj+RgEhQuP9edem/Hk4xhLyRvq0VWFpw1P',
    m1: 'Ku365IQW+tZBjdQomwpCkr+kc3iMaQBbgUVVGujr41g=',
    m2: 'nP8OzQPdc2dZi6F+7HoaxicL6aEdT5lEIBQPdm2IJGw=',
  },
  {
    name: 'S with a leading zero byte',
    appleId: 'owner@icloud.com',
    password: 'hunter2!',
    protocol: 's2k',
    iteration: 1000,
    salt: 'euZLvsmIrXOUR2hqXj2neQ==',
    secret: 'a54b084fb0a40fc974ce264f3450ba13f80c448ba0646a479919d12db2441640',
    a: 'ad7EDUTyT3TUUD9asiOmtgJv67m6soKx9X9allNONczVgtHEiURwGlv4GewaD0lvEYXwiu4auQ3x+7mACOrehzNjntbWnGJT'
      + 'kp4JS9ULszTtGsFpwu4ScuKJ65gW7U9wwbJK9HD1N7pg5cCZs2+oWnJywsZosROBXjIREqTeHN0YACUj/j4jgMtEFerVQWdz'
      + 'ISsf9U8Idz1J8mJQ1TcV23PWtwoX6M78BE8MnMIyYkzD9yGTPiReerQ8nIXC27wTv2tiKBD4mKAh43qHfI7kZfjGgBmgnQ8y'
      + 'Jx6jkv8/E51lLbINBVHqbbqCZzZ3tcV1QT8TcPxLvWQ7G0zyBrlBDw==',
    b: 'ATzz45bF45BU6pbDAHpmpBrDcBmK61sKq1cqmMYMPTwBVy+SjIKxGxLVOJI3qJ3hHCCZIzNmo1/gBk1JtpeaXbgaTqiIsWJP'
      + 'NeEP3uysHUTLDFEE7pvo5+PVbSr52i/qXnPFwo0kmetGU4DIl6+FnQTW0TCrkv6VMxqw5Pj1v8/GK4GOjkN7xWD9UrUm5jNC'
      + 'hr7LGwx45vE+eTYtTNsibqtFCZsaQGulC0StgdHIAGsTQeTlgmOe7Fbj+ozA9ptPKlWKVdCCS1R2GOZDBm4rlDVytIG3PawC'
      + 'Xm7Fkn3bJbzjuOYsgVSs+RV/Ul8/5EaiW1uTdvexUgfgodMhDn4pBQ==',
    m1: 'mGu0Vq5IWkbO3OVF1d4M6JAIui8dV2Cpl+5FKXi3LXw=',
    m2: 'rjBHiC/7BcFeoJQQ6ajToxls3UXkd3ylDTCrYqP1udE=',
  },
]

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16))
}

describe('Apple SRP', () => {
  it.each(VECTORS)('matches the reference proof: $name', async (vector) => {
    const secret = hexBytes(vector.secret)

    expect(srpBase64(srpPublic(secret))).toBe(vector.a)
    await expect(srpProof(vector.appleId, vector.password, {
      salt: vector.salt, b: vector.b, iteration: vector.iteration, protocol: vector.protocol,
    }, secret)).resolves.toEqual({ m1: vector.m1, m2: vector.m2 })
  })

  it('refuses a challenge it cannot answer before deriving anything', async () => {
    const [vector] = VECTORS
    const secret = hexBytes(vector.secret)
    const challenge = { salt: vector.salt, b: vector.b, iteration: vector.iteration, protocol: vector.protocol }

    for (const broken of [
      { ...challenge, b: '' },
      { ...challenge, b: 'AA==' },
      { ...challenge, salt: 'not base64!' },
      { ...challenge, iteration: Number.NaN },
      { ...challenge, iteration: 0 },
    ]) {
      await expect(srpProof(vector.appleId, vector.password, broken, secret)).rejects.toMatchObject({ status: 502 })
    }
  })
})
