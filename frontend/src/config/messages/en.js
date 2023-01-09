// Model https://github.com/marmelab/react-admin/blob/master/packages/ra-language-french/src/index.ts

module.exports = {
  app: {
    action: {
      accept: 'Accept',
      accept_contact_request: 'Accept contact request',
      add: 'Add',
      add_contact: 'Add contact',
      copy: 'Copy to clipboard',
      edit_profile: 'Edit my profile',
      ignore: 'Ignore',
      ignore_contact_request: 'Ignore contact request',
      login: 'Login with an account',
      reject: 'Reject',
      reject_contact_request: 'Reject contact request',
      remove_contact: 'Remove contact',
      send: 'Send',
      send_message: 'Send message',
      signup: 'Signup',
      reset_password: 'Reset password',
      set_new_password: 'Set new password',
    },
    page: {
      contacts: 'My network',
      contacts_short: 'Network',
      profile: 'My profile',
      profile_short: 'Profile',
      addresses: 'My addresses',
      addresses_short: 'Addresses',
      settings: 'Settings',
      settings_short: 'Settings',
    },
    card: {
      add_contact: 'Add a contact',
      contact_requests: 'Contact requests',
      share_contact: 'My contact link',
    },
    block: {
      contact_requests: 'New contact requests',
      g1_account: 'G1 account'
    },
    input: {
      about_you: 'A few words about you',
      message: 'Message',
      user_id: 'User ID',
      email: 'Email',
      current_password: 'Current password',
      new_password: 'New password',
      confirm_new_password: 'Confirm new password',
    },
    helper: {
      add_contact: 'To add an user to your network, you need to know his ID (format: @bob@server.com).',
      message_profile_show_right: "Sending a message to %{username} will give him/her the right to see your profile, in order to be able to respond.",
      profile_visibility: "Your profile is visible only by users you have accepted in your network",
      share_contact: 'To connect with someone you know, you can send him the link below.',
      g1_tipjar_field: 'To send G1 money to this user, copy his public key below and use it inside the Cesium software.',
      g1_tipjar_input: 'The public key of your Ğ1 account. This will allow other members to easily send you money.'
    },
    message: {
      copied_to_clipboard: 'Copied !',
      no_condition: 'None',
      you_participated_to_same_event: 'You participated to the same event',
    },
    notification: {
      contact_request_accepted: 'Contact request accepted',
      contact_request_ignored: 'Contact request ignored',
      contact_request_rejected: 'Contact request rejected',
      contact_request_sent: 'Contact request sent',
      contact_removed: 'Contact removed',
      login_to_connect_user: 'Please create an account to connect with %{username}',
      message_sent: 'Your message has been sent',
      message_send_error: "Error while sending the message: %{error}",
      profile_data_not_found: "Your profile couldn't be found, please reconnect yourself",
      user_not_found: "User %{username} doesn't exist",
      reset_password_submitted: "An email has been send with reset password instructions",
      reset_password_error: 'An error occurred',
      password_changed: "Password changed successfully",
      new_password_error: 'An error occurred',
      invalid_password: "Invalid password",
      get_settings_error: 'An error occurred',
      update_settings_error: 'An error occurred',
    },
    user: {
      unknown: 'Unknown',
    },
    validation: {
      email: "Must be a valid email",
      confirmNewPassword: "Must be the same as new password field"
    },
  },
};
