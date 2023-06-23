import DB, { sha256, fieldsForSelect, fromAurora, sanitizeData, AURORA_TYPE } from '../lib/DB';
import { log } from '../lib/Logger';
import UnauthorizedError from '../errors/UnauthorizedError';
import Session from '../models/Session';
import RecordNotFound from '../errors/RecordNotFound';
import { generateRandVals } from '../lib/Math';

class People {
  
  //TODO: Maybe we can interrogate the database so that this becomes DRY-er?
  static fields()  {  
    return {
     id: {auroraType: AURORA_TYPE.LONG, allowOnCreate: false}, 
     first_name: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true }, 
     last_name: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true }, 
     role: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true }, 
     login_enabled: {auroraType: AURORA_TYPE.BOOLEAN, allowOnCreate: true }, 
     email: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true }, 
     created_at: {auroraType: AURORA_TYPE.STRING, allowOnCreate: false  }, 
    };
  };

 // fields for sme_people_professional 

/*
static async displayPeopleProfessional() { // returns array of Timesheet Table
  const db = new DB();
  const sql = `select * from sme_people_professional`;
              
  const data = await db.executeStatement(sql, []);
 
  if (data.records.length === 0) {
    return null;
  } 

  const peopleRaw  = data.records;
  const people = peopleRaw.map(person => new People(fromAurora(person, People.peopleProfessionalFields())));
  return people;   
}*/
  
  static async login(email, password) {
      const db = new DB();
      const sql = `SELECT id, salt, first_name, last_name, force_password_change FROM people 
        WHERE email=:email AND encrypted_password = sha2(CONCAT(:password, salt), 256) AND login_enabled = 1 AND approved = 1 LIMIT 1;`; 
        
      const data = await db.executeStatement(sql, [
        {name: 'email', value:{stringValue: email}},
        {name: 'password', value:{stringValue: password}}
      ]);
      
      if (data.records.length === 0) {
        throw new UnauthorizedError("Invalid username and/or password.");
      } 
      
      const user = data.records[0]
      const [
        {longValue: userId},
        {stringValue: userSalt},
        {stringValue: firstName},
        {stringValue: lastName},
        {booleanValue: forcePasswordChange},
      ] = user;

      const capabilitiesSQL = `SELECT DISTINCT capabilities.name, group_capabilities.params1, group_capabilities.params2, group_capabilities.params3 from people_groups 
      LEFT JOIN groups ON groups.id = people_groups.group_id
      LEFT JOIN group_capabilities ON group_capabilities.group_id = groups.id
      LEFT JOIN capabilities ON capabilities.id = group_capabilities.capabilities_id
      WHERE people_groups.people_id = :people_id`;

      const groupsSQL = `SELECT groups.name FROM groups LEFT JOIN people_groups ON groups.id = people_groups.group_id WHERE people_groups.people_id = :people_id`;
      
      // separate SQL for capabilities and roles so we dont have to filter duplicated values.
      const rawCapabilities = await db.executeStatement(capabilitiesSQL, [
        {name: 'people_id', value:{longValue: userId}},
      ]);

      const rawGroups = await db.executeStatement(groupsSQL, [
        {name: 'people_id', value:{longValue: userId}},
      ]);

      const capabilities = rawCapabilities.records.reduce((acc, curr) => {
        const [{ stringValue: capability },
                { stringValue: params1 },
                { stringValue: params2 },
                { stringValue: params3 }] = curr;

        return [...acc, 
                ...((!params1 && !params2 && !params3) ? [capability] : []),
                ...(params1 ? [`${capability}(${params1})`] : []), 
                ...(params2 ? [`${capability}(${params1 ?? 'NULL'},${params2})`] : []), 
                ...(params3 ? [`${capability}(${params1 ?? 'NULL'},${params2 ?? 'NULL'},${params3})`] : [])]
      }, []);

      const groups = rawGroups.records.map(([{ stringValue: role }])=> role);
     
      const session_token = sha256(`${userId}${userSalt}${Date.now()}`);
      
      const sessionSql = `INSERT INTO sessions (\`people_id\`, \`session\`, \`session_expiry\`)  
        VALUES(:id, :session, DATE_ADD(NOW(), INTERVAL 744 HOUR))`;
        
      await db.executeStatement(sessionSql, [
        {name: 'session', value:{stringValue: session_token}},
        {name: 'id', value:{longValue: userId}},
      ]);
      
      //Query available permissions
      let defaultEntityType, defaultEntityTypeData;
      const defaultEntityTypeSQL = `SELECT entity_types.slug FROM entity_types ORDER BY id ASC LIMIT 1`;
      defaultEntityTypeData = await db.executeStatement(defaultEntityTypeSQL, []);
      [{stringValue: defaultEntityType}] = defaultEntityTypeData.records[0];
 
      return { session_token, user: {firstName, lastName, groups, capabilities, defaultEntityType, forcePasswordChange, userId} };
  }

  static async createUser({ firstName, lastName, loginEnabled, approved, email, password, forcePasswordChange }) {
    const db = new DB();
    const salt = await generateRandVals(5);

    const sql = `INSERT INTO people (first_name, last_name, role, login_enabled, approved, email, encrypted_password, salt, created_at, force_password_change)
                 VALUES (:first_name, :last_name, 'deprecated', :login_enabled, :approved, :email, SHA2(CONCAT(:password, :salt), 256), :salt, NOW(), :force_password_change)`;
    const params = [
       { name: 'first_name', value: { stringValue: firstName } },
       { name: 'last_name', value: { stringValue: lastName } },
       { name: 'login_enabled', value: { booleanValue: loginEnabled } },
       { name: 'approved', value: { booleanValue: approved } },
       { name: 'email', value: { stringValue: email } },
       { name: 'password', value: { stringValue: password } },
       { name: 'salt', value: { stringValue: salt } },
       { name: 'force_password_change', value: { booleanValue: forcePasswordChange } }
    ];

    // Returns the id
    const { generatedFields } = await db.executeStatement(sql, params);

    return generatedFields[0].longValue;
  }

  static async get({ id }) {
    const db = new DB();

    const sql = `SELECT first_name, last_name, login_enabled, approved, force_password_change, email, created_at FROM people WHERE id = :id`;
    const params = [ { name: 'id', value: { longValue: id } } ];

    const data = await db.executeStatement(sql, params);
    const record = data.records.map(
        ([
            { stringValue: firstName },
            { stringValue: lastName },
            { booleanValue: loginEnabled },
            { booleanValue: approved },
            { booleanValue: forcePasswordChange },
            { stringValue: email },
            { stringValue: createdAt },
        ]) => ({ firstName, lastName, loginEnabled, approved, forcePasswordChange, email, createdAt }));

    return record;
  }

  static async getAll({ approved, pending  } = {}) {
    const db = new DB();

    let sql = `SELECT id, CONCAT(first_name, " ", last_name) AS full_name, login_enabled, email, created_at FROM people`;
    if ((approved && pending) || (!approved && !pending)) {
    } else if (approved) {
        sql = `${sql} WHERE approved = true`
    } else {
        sql = `${sql} WHERE approved = false`
    }

    const data = await db.executeStatement(sql);
    const records = data.records.map(
        ([
            { longValue: id },
            { stringValue: name },
            { booleanValue: loginEnabled },
            { stringValue: email },
            { stringValue: createdAt },
        ]) => ({ id, name, loginEnabled, email, createdAt }));

    return records;
  }

  static async findByColumn(column, value) {
    const db = new DB();

    // columns as parameters wont work for some reason
    const sql = `SELECT * FROM people WHERE ${column} = :value`;
    const params = [
        { name: 'value', value: { stringValue: value } }
    ];

    const data = await db.executeStatement(sql, params);

    return data.records[0];
  }

  static async approve({ id }) {
    const db = new DB();
    const sql = `UPDATE people SET approved = true WHERE id = :id`;
    const params = [ { name: 'id', value: { longValue: id } } ];

    await db.executeStatement(sql, params);

    return true;
  }

  static async delete({ id }) {
    const db = new DB();
    const sql = `DELETE FROM people WHERE id = :id`;
    const params = [ { name: 'id', value: { longValue: id } } ];

    await db.executeStatement(sql, params);

    return true;
  }

  static async displayCurrentUser(session) { // return User's information
    const db = new DB();
    const session_data = await Session.getSession(session); // gets people_id and sme_tenant_id based on session
    const people_id = session_data.people_id;
    const sql = `select sme_people.id, sme_people.first_name, sme_people.last_name, sme_people.company_position, 
                  sme_people.login_enabled, sme_people.email, sme_people.created_at, sme_people.sme_timezone_id, 
                  sme_people.sme_tenant_id, sme_timezones.timezones_country, sme_timezones.timezones_offset
                  FROM sme_people 
                  LEFT JOIN sme_timezones 
                  ON sme_people.sme_timezone_id = sme_timezones.id
                  WHERE sme_people.id = :people_id AND
                  sme_people.sme_tenant_id = :sme_tenant_id
                  LIMIT 1`;
                  
    const data = await db.executeStatement(sql, [
      {name: 'people_id', value:{longValue: people_id}},
      {name: 'sme_tenant_id', value:{longValue: session_data.sme_tenant_id}},
    ]);
    
    if (data.records.length === 0) {
      return null;
    } 

    return new People(fromAurora(data.records[0], People.fields()))
  }


  static async updateUserInfo({ id, firstName, lastName, email, approved, loginEnabled, forcePasswordChange }){
    const db = new DB();
    const updateSql =  `UPDATE people 
                        SET 
                            first_name = :first_name, 
                            last_name = :last_name, 
                            email = :email,
                            login_enabled = :login_enabled,
                            approved = :approved,
                            force_password_change = :force_password_change
                        WHERE 
                            id = :id`;

    const executeStatementParam = {
        id: {name: 'id', value: {longValue: id}},
        first_name: {name: 'first_name', value: {stringValue: firstName}},
        last_name: {name: 'last_name', value: {stringValue: lastName}},
        email: {name: 'email', value: {stringValue: email}},
        login_enabled: {name: 'login_enabled', value: {booleanValue: loginEnabled}},
        approved: {name: 'approved', value: {booleanValue: approved}},
        force_password_change: {name: 'force_password_change', value: {booleanValue: forcePasswordChange}},
    }

    await db.executeStatement(updateSql, Object.values(executeStatementParam)); 

    return true;
  }

  //A password changer needs a method of its own for security purposes
  static async updatePassword({id, oldPassword, newPassword, forcePasswordChange}){

    //early exit if the old password or the new password is not provided.
    if (!oldPassword || !newPassword) throw new Error('Passwords are required.');

    const db = new DB();

    //Check if the provided oldPassword is correct.
    const checkPasswordSql = `SELECT id FROM people 
                              WHERE id = :id AND encrypted_password = sha2(CONCAT(:oldPassword, salt), 256) AND login_enabled = 1  LIMIT 1`;
      
    const sqlPass = await db.executeStatement(checkPasswordSql, [
      {name: 'id', value: {longValue: id}},
      {name: 'oldPassword', value:{stringValue: oldPassword}},
    ]);
    if (sqlPass.records.length === 0) {
      throw new RecordNotFound("Incorrect password");
    }

    const updateSql =  `
    UPDATE people  
    SET
      encrypted_password = sha2(CONCAT(:newPassword, :salt), 256),
      force_password_change = :force_password_change,
      salt = :salt
    WHERE id = :id`;

    const salt = await generateRandVals(5);
    const executeStatementParam = [
      {name: 'id', value: {longValue: id}},
      {name: 'newPassword', value: {stringValue: newPassword}},
      {name: 'force_password_change', value: {booleanValue: false}},
      {name: 'salt', value: {stringValue: salt}}
    ];

    const data = await db.executeStatement(updateSql, executeStatementParam); 
    return false;
      
  }

  // This method is specifically for the user management page. The admin
  // can update a user's password without needing their old password,
  // or if the user has forgotten their password and wants to change it
  static async resetPassword({ id, newPassword, forcePasswordChange }) {
    const db = new DB();

    const salt = await generateRandVals(5);
    const sql = `UPDATE people SET
                    encrypted_password = sha2(CONCAT(:newPassword, :salt), 256),
                    force_password_change = :force_password_change,
                    salt = :salt
                 WHERE id = :id`;
    const params = [
      { name: 'id', value: { longValue: id } },
      { name: 'newPassword', value: { stringValue: newPassword } },
      { name: 'force_password_change', value: { booleanValue: forcePasswordChange } },
      { name: 'salt', value: { stringValue: salt } }
    ];

     await db.executeStatement(sql, params); 

    return false;
  }
  
  //This is deprecated. Use Session.assert instead.
  
  static async isSessionAlive(session_token) {
    const db = new DB();
    const sql = `SELECT sme_sessions.session FROM sme_sessions JOIN people ON sme_sessions.people_id = sme_people.id WHERE 
      sme_sessions.session = :session AND
      sme_sessions.session_expiry >= NOW() AND
      sme_people.login_enabled = 1 
    `;  
    try {
      const data = await db.executeStatement(sql, [
        {name: 'session', value:{stringValue: session_token}},
      ]);
      
      return data.records.length > 0; 
      
    } catch (ex) {
      console.error(ex);  
      return false;
    }
  }
  
  static async findBySession(session) {
    
    try {
      
      const db = new DB();
      
      //TODO: We need to think on how to do joins elegantly.
      //Is it time to use an ORM? Is it worth the effort?
      const fields = [
        ...Object.keys(People.fields()).map(key => `sme_people.${key}`),
        'sme_tenants.homepage'
        ];
      const sql = `SELECT ${fields.join(',')} FROM sme_sessions 
        JOIN sme_people ON sme_sessions.people_id = sme_people.id 
        JOIN sme_tenants ON sme_sessions.sme_tenant_id = sme_tenants.id
        WHERE 
        sme_sessions.session = :session AND
        sme_sessions.session_expiry >= NOW() AND
        sme_people.login_enabled = 1 
        LIMIT 1
      `;  
      
      const data = await db.executeStatement(sql, [
        {name: 'session', value:{stringValue: session}},
      ]);
      
      
      const person_raw = data.records[0];
      
      //fields not in the people table, as it is a join. How to do this elegantly?
      const SME_TENANTS_HOMEPAGE = 0;
      const sme_tenants_homepage = person_raw[Object.keys(People.fields()).length + SME_TENANTS_HOMEPAGE]?.stringValue;
      
      const person = new People(fromAurora(person_raw, People.fields()));
      //again, how do we do relationships elegantly?
      person.tenant = {homepage: sme_tenants_homepage };
      return person; 
      
    } catch (ex) {
      log(ex.stack);  
      return false;
    }
  }
  
  
  //Let the controller handle the exceptions
  static async all(session) {
      const db = new DB();
      
      const fields = [
        ...Object.keys(People.fields()).map(key => `sme_people.${key}`)
        ];
        
      const sql = `SELECT ${fields.join(',')} FROM sme_people_tenants
        LEFT JOIN sme_people ON sme_people_tenants.sme_people_id = sme_people.id 
        LEFT JOIN sme_sessions ON sme_people_tenants.sme_tenant_id = sme_sessions.sme_tenant_id
        WHERE 
          sme_sessions.session = :session AND
          sme_sessions.session_expiry >= NOW()
        ORDER BY first_name ASC
      `;  
      
      const data = await db.executeStatement(sql, [
        {name: 'session', value:{stringValue: session}},
      ]);
      
      const peopleRaw  = data.records;
      const people = peopleRaw.map(person => new People(fromAurora(person, People.fields())));
      return people;   
  }

  static peopleProfessionalFields()  {  
    return {
      sme_people_id: {auroraType: AURORA_TYPE.LONG, allowOnCreate: true, allowOnUpdate: true},
      payment_to: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true, allowOnUpdate: true},
      code: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true, allowOnUpdate: true },
      rate: {auroraType: AURORA_TYPE.STRING, allowOnCreate: true, allowOnUpdate: true},
    };
  };


  static async displayPeopleProfessional(session) { // returns array of Timesheet Table
    const db = new DB();
    const session_data = await Session.getSession(session); // gets people_id and sme_tenant_id based on session
    const sme_tenant_id = session_data.sme_tenant_id;
    const sql = `select sme_people_id, payment_to, code, rate from sme_people_professional 
                 WHERE sme_tenant_id = :sme_tenant_id`;
    
    let executeStatementParam = [
      {name: 'sme_tenant_id', value:{longValue: sme_tenant_id}},
    ];
                
    const data = await db.executeStatement(sql, executeStatementParam);
   
    if (data.records.length === 0) {
      return null;
    } 
  
    const peopleRaw  = data.records;
    const people = peopleRaw.map(person => new People(fromAurora(person, People.peopleProfessionalFields())));
    return people;   
  }

  constructor(rawData) {
    Object.assign(this, rawData);
  };
    
  
  displayName() {
    return `${this.first_name}`;
  }
  
}

export default People;
