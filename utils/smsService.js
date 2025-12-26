const twilio = require('twilio');

class SMSService {
  constructor() {
    this.isConfigured = false;
    this.client = null;
    
    // Initialize Twilio client if credentials exist
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        this.client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        this.isConfigured = true;
        console.log('✅ Twilio SMS service configured');
      } catch (error) {
        console.error('❌ Failed to initialize Twilio:', error);
      }
    } else {
      console.warn('⚠️  Twilio credentials not found. Running in simulation mode.');
    }
  }

  /**
   * Send password reset code via SMS
   * @param {string} phoneNumber - Recipient's phone number (with country code)
   * @param {string} resetCode - 6-digit reset code
   * @param {string} userName - User's name (optional)
   * @returns {Promise<Object>} - Result of SMS send operation
   */
  async sendResetCode(phoneNumber, resetCode, userName = 'User') {
    try {
      // Format phone number if needed
      const formattedPhone = this.formatPhoneNumber(phoneNumber);
      
      // Create SMS message
      const messageBody = `Hi ${userName},\n\nYour password reset code is: ${resetCode}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, please ignore this message.\n\n- ${process.env.APP_NAME || 'Your App Team'}`;

      if (this.isConfigured && this.client && process.env.SMS_ENABLED !== 'false') {
        // Send real SMS via Twilio
        const message = await this.client.messages.create({
          body: messageBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: formattedPhone
        });

        console.log(`✅ SMS sent to ${formattedPhone}, Message SID: ${message.sid}`);
        
        // Log cost if available
        if (message.price) {
          console.log(`💰 SMS cost: ${message.price} ${message.priceUnit}`);
        }

        return {
          success: true,
          messageId: message.sid,
          to: formattedPhone,
          status: message.status,
          mode: 'production'
        };
      } else {
        // Simulation mode (for development)
        console.log(`📱 [SIMULATION] SMS would be sent to ${formattedPhone}:`);
        console.log(`📱 Message: ${messageBody}`);
        console.log(`📱 Reset Code: ${resetCode}`);
        
        // Store for testing purposes
        if (!global.testSMSCodes) global.testSMSCodes = [];
        global.testSMSCodes.push({
          phone: formattedPhone,
          code: resetCode,
          message: messageBody,
          timestamp: new Date()
        });

        return {
          success: true,
          messageId: `sim-${Date.now()}`,
          to: formattedPhone,
          status: 'simulated',
          mode: 'simulation',
          debugCode: resetCode // Only in simulation
        };
      }
    } catch (error) {
      console.error('❌ SMS sending failed:', error.message);
      
      // Handle specific Twilio errors
      if (error.code === 21211) {
        throw new Error('Invalid phone number format');
      } else if (error.code === 21608) {
        throw new Error('Twilio phone number not verified (in trial mode)');
      } else if (error.code === 21614) {
        throw new Error('Phone number is not SMS capable');
      }
      
      throw new Error(`Failed to send SMS: ${error.message}`);
    }
  }

  /**
   * Send login OTP code
   * @param {string} phoneNumber - Recipient's phone number
   * @param {string} otp - 6-digit OTP
   * @returns {Promise<Object>} - Result of SMS send operation
   */
  async sendLoginOTP(phoneNumber, otp) {
    const formattedPhone = this.formatPhoneNumber(phoneNumber);
    const messageBody = `Your login OTP is: ${otp}\nValid for 10 minutes.`;

    return this.sendSMS(formattedPhone, messageBody, 'login-otp');
  }

  /**
   * Send welcome message
   * @param {string} phoneNumber - Recipient's phone number
   * @param {string} userName - User's name
   * @returns {Promise<Object>} - Result of SMS send operation
   */
  async sendWelcomeMessage(phoneNumber, userName) {
    const formattedPhone = this.formatPhoneNumber(phoneNumber);
    const messageBody = `Welcome ${userName} to ${process.env.APP_NAME || 'Our App'}! Your account has been successfully created.`;

    return this.sendSMS(formattedPhone, messageBody, 'welcome');
  }

  /**
   * Generic SMS sending method
   * @private
   */
  async sendSMS(to, body, type = 'generic') {
    if (this.isConfigured && this.client && process.env.SMS_ENABLED !== 'false') {
      try {
        const message = await this.client.messages.create({
          body: body,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: to
        });

        console.log(`✅ ${type} SMS sent to ${to}, SID: ${message.sid}`);
        return {
          success: true,
          messageId: message.sid,
          status: message.status
        };
      } catch (error) {
        console.error(`❌ ${type} SMS failed:`, error.message);
        throw error;
      }
    } else {
      console.log(`📱 [SIMULATION] ${type} SMS to ${to}: ${body}`);
      return {
        success: true,
        mode: 'simulation'
      };
    }
  }

  /**
   * Format phone number to international format
   * @private
   */
  formatPhoneNumber(phoneNumber) {
    // Remove any non-digit characters
    let cleanNumber = phoneNumber.replace(/\D/g, '');
    
    // If number doesn't start with +, add country code
    if (!phoneNumber.startsWith('+')) {
      // Default to +91 for India, change as needed
      const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '91';
      
      // Check if number already has country code
      if (cleanNumber.length === 10) {
        cleanNumber = `+${defaultCountryCode}${cleanNumber}`;
      } else if (cleanNumber.length === 12 && cleanNumber.startsWith('91')) {
        cleanNumber = `+${cleanNumber}`;
      } else {
        // Add + if missing
        cleanNumber = `+${cleanNumber}`;
      }
    }
    
    return cleanNumber;
  }

  /**
   * Check if a phone number is valid
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} - Whether the phone number is valid
   */
  isValidPhoneNumber(phoneNumber) {
    // Basic validation - adjust regex based on your country
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phoneNumber);
  }

  /**
   * Get last sent SMS for testing (simulation mode only)
   * @param {string} phoneNumber - Phone number to look up
   * @returns {Object|null} - Last sent SMS data
   */
  getLastSentSMS(phoneNumber) {
    if (global.testSMSCodes) {
      const formattedPhone = this.formatPhoneNumber(phoneNumber);
      return global.testSMSCodes
        .filter(sms => sms.phone === formattedPhone)
        .pop() || null;
    }
    return null;
  }
}

// Create singleton instance
const smsService = new SMSService();

// Export the service
module.exports = smsService;